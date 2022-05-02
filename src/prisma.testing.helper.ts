import { Prisma, PrismaClient } from '@prisma/client';

export class PrismaTestingHelper<T extends PrismaClient> {
  private readonly proxyClient: T;
  private currentPrismaTransactionClient?: Prisma.TransactionClient;
  private endCurrentTransactionPromise?: (value?: unknown) => void;

  /**
   * Instantiate a new PrismaTestingHelper for the given PrismaClient. Will start transactions on this given client.
   * Does not support multiple transactions at once, instantiate multiple PrismaTestingHelpers if you need this.
   */
  constructor(private readonly prismaClient: T) {
    const prismaTestingHelper = this;
    this.proxyClient = new Proxy(prismaClient, {
      get(target, prop, receiver) {
        if(prop === '$transaction') {
          // TODO - maybe add savepoints here in the future? (https://github.com/prisma/prisma/issues/12898)
          return async (args: any) => {
            if(Array.isArray(args)) {
              // "Regular" transaction - list of querys that must be awaited
              for(const query of args) {
                await query;
              }
            } else {
              // Interactive transaction - callback function that gets the prisma transaction client as argument
              return args(prismaTestingHelper.currentPrismaTransactionClient);
            }
          };
        }
        if(prismaTestingHelper.currentPrismaTransactionClient != null && (prismaTestingHelper.currentPrismaTransactionClient as any)[prop] != null) {
          return Reflect.get(prismaTestingHelper.currentPrismaTransactionClient, prop, receiver);
        }
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  /**
   * Returns a client that will always route requests to the current active transaction.
   * All other calls will be routed to the original given prismaClient.
   */
  public getProxyClient(): T {
    return this.proxyClient;
  }

  /**
   * Returns a Prisma transaction client that can be used instead of the regular testing client to run a transaction.
   *
   */
  public async startNewTransaction(opts: { timeout?: number; maxWait?: number}): Promise<void> {
    if(this.endCurrentTransactionPromise != null) {
      throw new Error('rollbackCurrentTransaction must be called before getting a new prisma client');
    }
    // This is a workaround for https://github.com/prisma/prisma/issues/12458
    return new Promise(resolve => {
      this.prismaClient.$transaction(async prisma => {
        this.currentPrismaTransactionClient = prisma;
        await new Promise(innerResolve => {
          this.endCurrentTransactionPromise = innerResolve;
          resolve();
        });
        throw new Error('[fast-prisma-testing] internal rollback');
      }, opts).catch(() => {});
    });
  }

  public rollbackCurrentTransaction(): void {
    if(this.endCurrentTransactionPromise == null) {
      throw new Error('No transaction currently active');
    }
    this.endCurrentTransactionPromise();
    this.endCurrentTransactionPromise = undefined;
  }
}
