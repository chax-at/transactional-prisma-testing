import { Prisma, PrismaClient } from '@prisma/client';

export class PrismaTestingHelper<T extends PrismaClient> {
  private readonly proxyClient: T;
  private currentPrismaTransactionClient?: Prisma.TransactionClient;
  private endCurrentTransactionPromise?: (value?: unknown) => void;
  private savepointId = 0;
  private transactionLock: Promise<void> | null = null;

  /**
   * Instantiate a new PrismaTestingHelper for the given PrismaClient. Will start transactions on this given client.
   * Does not support multiple transactions at once, instantiate multiple PrismaTestingHelpers if you need this.
   *
   * @param prismaClient - The original PrismaClient or PrismaService. All calls to functions that don't exist on the transaction client will be routed to this original object.
   * @param options
   */
  constructor(private readonly prismaClient: T, private readonly options?: { disableTransactionLock?: boolean }) {
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
          return Reflect.get(prismaTestingHelper.currentPrismaTransactionClient, prop, receiver);
        }
        // The property does not exist on the transaction client, relay to original client
        return Reflect.get(target, prop, receiver);
      }
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
    if(this.options?.disableTransactionLock !== true) {
      while(this.transactionLock != null) {
        await this.transactionLock;
      }
    }
    if(this.currentPrismaTransactionClient == null) {
      throw new Error('[transactional-prisma-testing] Invalid call to $transaction while no transaction is active.');
    }
    let lockResolve!: (value: (void | PromiseLike<void>)) => void;
    this.transactionLock = new Promise(resolve => {
      lockResolve = resolve;
    });
    const savepointName = `transactional_testing_${this.savepointId++}`;
    await this.currentPrismaTransactionClient.$executeRawUnsafe(`SAVEPOINT ${savepointName}`);
    try {
      const ret = await func();
      await this.currentPrismaTransactionClient.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepointName}`);
      return ret;
    } catch(err) {
      await this.currentPrismaTransactionClient.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw err;
    } finally {
      this.transactionLock = null;
      lockResolve();
    }
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
  public async startNewTransaction(opts?: { timeout?: number; maxWait?: number}): Promise<void> {
    if(this.endCurrentTransactionPromise != null) {
      throw new Error('rollbackCurrentTransaction must be called before starting a new transaction');
    }
    // This is a workaround for https://github.com/prisma/prisma/issues/12458
    return new Promise(resolve => {
      this.prismaClient.$transaction(async prisma => {
        this.currentPrismaTransactionClient = prisma;
        await new Promise(innerResolve => {
          this.endCurrentTransactionPromise = innerResolve;
          resolve();
        });
        throw new Error('[transactional-prisma-testing] internal rollback');
      }, opts).catch(() => {});
    });
  }

  /**
   * Ends the currently active transaction. Must be called after each test.
   */
  public rollbackCurrentTransaction(): void {
    if(this.endCurrentTransactionPromise == null) {
      throw new Error('No transaction currently active');
    }
    this.endCurrentTransactionPromise();
    this.endCurrentTransactionPromise = undefined;
  }
}
