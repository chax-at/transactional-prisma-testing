import { Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

type PromiseResolveFunction = (value: (void | PromiseLike<void>)) => void;
const internalRollbackErrorSymbol = Symbol('Internal transactional-prisma-testing rollback error symbol');
/**
 * Postgres can cache up to 64 sub transactions by default (PGPROC_MAX_CACHED_SUBXIDS)
 * By releasing savepoints when reaching 56, we ensure we stay below this number but don't have to release savepoints all the time
 */
const MAX_ACTIVE_SAVEPOINTS = 56;

export class PrismaTestingHelper<T extends {
  $transaction(arg: unknown[], options?: unknown): Promise<unknown>;
  $transaction<R>(fn: (client: unknown) => Promise<R>, options?: unknown): Promise<R>;
}> {
  private readonly proxyClient: T;
  private currentPrismaTransactionClient?: Prisma.TransactionClient;
  private endCurrentTransactionPromise?: (value?: unknown) => void;
  private savepointId = 0;
  private transactionLock: Promise<void> | null = null;
  private readonly asyncLocalStorage = new AsyncLocalStorage<{ transactionSavepoint: string }>();

  /**
   * Instantiate a new PrismaTestingHelper for the given PrismaClient. Will start transactions on this given client.
   * Does not support multiple transactions at once, instantiate multiple PrismaTestingHelpers if you need this.
   *
   * @param prismaClient - The original PrismaClient or PrismaService. All calls to functions that don't exist on the transaction client will be routed to this original object.
   */
  constructor(private readonly prismaClient: T) {
    const prismaTestingHelper = this;
    this.proxyClient = new Proxy(prismaClient, {
      get(target, prop, receiver) {
        if(prismaTestingHelper.currentPrismaTransactionClient == null) {
          // No transaction active, relay to original client
          return Reflect.get(target, prop, receiver);
        }

        const descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (descriptor && !descriptor.configurable && !descriptor.writable) {
          // If the value is non-writable, non-configurable, then the proxy must return the original value
          // https://262.ecma-international.org/8.0/#sec-proxy-object-internal-methods-and-internal-slots-get-p-receiver
          // This happens when using an extended Prisma client and `_extensions` is accessed (see #14)
          return Reflect.get(target, prop, receiver);
        }

        if(prop === '$transaction') {
          return prismaTestingHelper.transactionProxyFunction.bind(prismaTestingHelper);
        }

        if((prismaTestingHelper.currentPrismaTransactionClient as any)[prop] != null) {
          const ret = Reflect.get(prismaTestingHelper.currentPrismaTransactionClient, prop, receiver);
          // Check whether the return value looks like a prisma delegate (by checking whether it has a findFirst function)
          if(typeof ret === 'object' && 'findFirst' in ret && typeof ret.findFirst === 'function') {
            return prismaTestingHelper.getPrismaDelegateProxy(ret);
          }

          return ret;
        }
        // The property does not exist on the transaction client, relay to original client
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  private getPrismaDelegateProxy<U extends object>(original: U): U {
    const prismaTestingHelper = this;
    const prismaDelegateProxy = new Proxy(original, {
      get(target, prop, receiver) {
        const originalReturnValue = Reflect.get(original, prop, receiver);
        if(typeof originalReturnValue !== 'function') {
          return originalReturnValue;
        }

        // original function, e.g. `findFirst`
        const originalFunction = originalReturnValue as (...args: unknown[]) => Promise<unknown>;
        // Prisma functions only get evaluated once they're awaited (i.e. `then` is called)
        return (...args: unknown[]) => {
          const catchCallbacks: Array<(reason: any) => unknown> = [];
          const finallyCallbacks: Array<() => unknown> = [];
          const returnedPromise = {
            then: async (resolve: PromiseResolveFunction, reject: any) => {
              try {
                const isInTransaction = prismaTestingHelper.asyncLocalStorage.getStore()?.transactionSavepoint != null;
                if(!isInTransaction) {
                  // Implicitly wrap every query in a transaction
                  const value = await prismaTestingHelper.wrapInSavepoint(() => originalFunction.apply(prismaDelegateProxy, args));
                  return resolve(value as any);
                }

                const value = await originalFunction.apply(prismaDelegateProxy, args);
                return resolve(value as any);
              } catch(e) {
                try {
                  let error = e;
                  for(const catchCallback of catchCallbacks) {
                    error = await catchCallback(error);
                  }
                  if (reject) {
                    reject(error);
                  } else {
                    return Promise.reject(error);
                  }
                } catch(innerError) {
                  if (reject) {
                    reject(innerError);
                  } else {
                    return Promise.reject(innerError);
                  }
                }
              } finally {
                finallyCallbacks.forEach(c => c());
              }
            },
            catch: (callback: (reason: any) => unknown) => {
              // I don't exactly know how `catch` is supposed to work, but this should work for the simple case at least
              catchCallbacks.push(callback);
              return returnedPromise;
            },
            finally: (callback: () => unknown) => {
              finallyCallbacks.push(callback);
              return returnedPromise;
            },
          };

          return returnedPromise;
        };
      },
    });

    return prismaDelegateProxy;
  }

  /**
   * Replacement for the original prismaClient.$transaction function that will work inside transactions and uses savepoints.
   */
  private async transactionProxyFunction(args: unknown): Promise<unknown> {
    return this.wrapInSavepoint(async () => {
      if(Array.isArray(args)) {
        // "Regular" transaction - list of querys that must be awaited
        const ret = [];
        for(const query of args) {
          ret.push(await query);
        }
        return ret;
      } else if(typeof args === 'function') {
        // Interactive transaction - callback function that gets the prisma transaction client as argument
        return args(this.currentPrismaTransactionClient);
      } else {
        throw new Error('[transactional-prisma-testing] Invalid $transaction call. Argument must be an array or a callback function.');
      }
    });
  }

  /**
   * Creates a savepoint before calling the function. Will automatically do a rollback to the savepoint on error.
   */
  private async wrapInSavepoint<T>(func: () => Promise<T>): Promise<T> {
    // Save transaction client here to ensure that SAVEPOINT and RELEASE SAVEPOINT will be executed for the same transaction (e.g. if the user forgot to await this call).
    const transactionClient = this.currentPrismaTransactionClient;

    const isInTransaction = this.asyncLocalStorage.getStore()?.transactionSavepoint != null;
    let lockResolve = undefined;
    if(!isInTransaction) {
      lockResolve = await this.acquireTransactionLock();
    }

    try {
      if (transactionClient == null) {
        throw new Error('[transactional-prisma-testing] Invalid call to $transaction while no transaction is active.');
      }

      if (transactionClient !== this.currentPrismaTransactionClient) {
        throw new Error('[transactional-prisma-testing] Transaction client changed (and old transaction rollbacked) before query could be executed. Make sure you await all queries and your test does not end before all queries have been executed.');
      }

      const savepointIdToRelease = this.savepointId - MAX_ACTIVE_SAVEPOINTS;
      if (savepointIdToRelease >= 0 && savepointIdToRelease % MAX_ACTIVE_SAVEPOINTS === 0) {
        // This will release all later savepoints as well
        await transactionClient.$executeRawUnsafe(`RELEASE SAVEPOINT trnsctl_tst_${savepointIdToRelease}`);
      }

      const savepointName = `trnsctl_tst_${this.savepointId++}`;
      try {
        await transactionClient.$executeRawUnsafe(`SAVEPOINT ${savepointName}`);
        return await this.asyncLocalStorage.run({ transactionSavepoint: savepointName }, func);
      } catch (err) {
        await transactionClient?.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw err;
      }
    } finally {
      this.transactionLock = null;
      lockResolve?.();
    }
  }

  private async acquireTransactionLock(): Promise<PromiseResolveFunction> {
    while(this.transactionLock != null) {
      await this.transactionLock;
    }
    let lockResolve!: PromiseResolveFunction;
    this.transactionLock = new Promise(resolve => {
      lockResolve = resolve;
    });
    return lockResolve;
  }

  /**
   * Returns a client that will always route requests to the current active transaction.
   * All other calls will be routed to the original given prismaClient.
   */
  public getProxyClient(): T {
    return this.proxyClient;
  }

  /**
   * Starts a new transaction and automatically updates the proxy client (no need to fetch it again).
   * Must be called before each test.
   */
  public async startNewTransaction(opts?: { timeout?: number; maxWait?: number }): Promise<void> {
    if(this.endCurrentTransactionPromise != null) {
      throw new Error('[transactional-prisma-testing] rollbackCurrentTransaction must be called before starting a new transaction');
    }
    this.savepointId = 0;
    // This is a workaround for https://github.com/prisma/prisma/issues/12458
    return new Promise(resolve => {
      this.prismaClient.$transaction(async prisma => {
        this.currentPrismaTransactionClient = prisma as Prisma.TransactionClient | undefined;
        await new Promise(innerResolve => {
          this.endCurrentTransactionPromise = innerResolve;
          resolve();
        });

        // We intentionally want to do a rollback of the transaction after a succesful run
        throw internalRollbackErrorSymbol;
      }, opts).catch((error) => {
        if(error !== internalRollbackErrorSymbol) {
          throw error;
        }
      });
    });
  }

  /**
   * Ends the currently active transaction. Must be called after each test.
   */
  public rollbackCurrentTransaction(): void {
    if(this.endCurrentTransactionPromise == null) {
      throw new Error('[transactional-prisma-testing] No transaction currently active');
    }
    this.endCurrentTransactionPromise();
    this.endCurrentTransactionPromise = undefined;
  }
}
