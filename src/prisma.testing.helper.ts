import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

type PromiseResolveFunction = (value: (void | PromiseLike<void>)) => void;
const internalRollbackErrorSymbol = Symbol('Internal transactional-prisma-testing rollback error symbol');

export class PrismaTestingHelper<T extends PrismaClient> {
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
    return new Proxy(original, {
      get(target, prop, receiver) {
        const originalReturnValue = Reflect.get(original, prop, receiver);
        if(typeof originalReturnValue !== 'function') {
          return originalReturnValue;
        }

        // original function, e.g. `findFirst`
        const originalFunction = originalReturnValue as (...args: unknown[]) => Promise<unknown>;
        // Prisma functions only get evaluated once they're awaited (i.e. `then` is called)
        return (...args: unknown[]) => ({
          then: async (resolve: PromiseResolveFunction, reject: any) => {
            try {
              const isInTransaction = prismaTestingHelper.asyncLocalStorage.getStore()?.transactionSavepoint != null;
              if(!isInTransaction) {
                // Implicitly wrap every query in a transaction
                const value = await prismaTestingHelper.wrapInSavepoint(() => originalFunction(...args));
                resolve(value as any);
                return;
              }

              const value = await originalFunction(...args);
              resolve(value as any);
            } catch(e) {
              reject(e);
            }
          },
        });
      },
    });
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
    const isInTransaction = this.asyncLocalStorage.getStore()?.transactionSavepoint != null;
    let lockResolve = undefined;
    if(!isInTransaction) {
      lockResolve = await this.acquireTransactionLock();
    }

    const savepointName = `transactional_testing_${this.savepointId++}`;
    // Save transaction client here to ensure that SAVEPOINT and RELEASE SAVEPOINT will be executed for the same transaction (e.g. if the user forgot to await this call).
    //
    const transactionClient = this.currentPrismaTransactionClient;
    try {
      if(transactionClient == null) {
        throw new Error('[transactional-prisma-testing] Invalid call to $transaction while no transaction is active.');
      }
      await transactionClient.$executeRawUnsafe(`SAVEPOINT ${savepointName}`);
      const ret = await this.asyncLocalStorage.run({ transactionSavepoint: savepointName }, func);
      await transactionClient.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepointName}`);
      return ret;
    } catch(err) {
      await transactionClient?.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw err;
    } finally {
      this.transactionLock = null;
      lockResolve?.();
      if(transactionClient !== this.currentPrismaTransactionClient) {
        console.warn(`[transactional-prisma-testing] Transaction client changed while executing a query. Please make sure you await all queries in your test.`);
      }
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
        this.currentPrismaTransactionClient = prisma;
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
