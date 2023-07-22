# @chax-at/transactional-prisma-testing
This package provides an easy way to run test cases inside a single database transaction that will
be rolled back after each test. This allows fast test execution while still providing the same source database state for each test.
It also allows parallel test execution against the same database.

## Prerequisites
* You are using <a href="https://github.com/prisma/prisma">Prisma</a> 4.7.0 or later in your project.
* You are using PostgreSQL (other DBs might work but have not been tested).
* You are not using [Fluent API](https://www.prisma.io/docs/concepts/components/prisma-client/relation-queries#fluent-api).


## Usage
Install the package by running
```shell
npm i -D @chax-at/transactional-prisma-testing
```
Note that this will install the package as a dev dependency, intended to be used during tests only (remove the `-D` if you want to use it outside of tests).

### Example
The following example for a <a href="https://github.com/nestjs/nest">NestJS</a> project shows how this package can be used.
It is however possible to use this package with every testing framework, just check out the documentation below and adapt the code accordingly. 
You can simply replace the `PrismaService` with `PrismaClient` if you are not using NestJS.
```typescript
import { PrismaTestingHelper } from '@chax-at/transactional-prisma-testing';

// Cache for the PrismaTestingHelper. Only one PrismaTestingHelper should be instantiated per test runner (i.e. only one if your tests run sequentially).
let prismaTestingHelper: PrismaTestingHelper<PrismaService> | undefined;
// Saves the PrismaService that will be used during test cases. Will always execute queries on the currently active transaction.
let prismaService: PrismaService;

// This function must be called before every test
async function before(): Promise<void> {
  if(prismaTestingHelper == null) {
    // Initialize testing helper if it has not been initialized before
    const originalPrismaService = new PrismaService();
    // Seed your database / Create source database state that will be used in each test case (if needed)
    // ...
    prismaTestingHelper = new PrismaTestingHelper(originalPrismaService);
    // Save prismaService. All calls to this prismaService will be routed to the currently active transaction
    prismaService = prismaTestingHelper.getProxyClient();
  }

  await prismaTestingHelper.startNewTransaction();
}

// This function must be called after every test
function after(): void {
  prismaTestingHelper?.rollbackCurrentTransaction();
}

// NestJS specific code: Replace the original PrismaService when creating a testing module
// Note that it is possible to cache this result and use the same module for all tests. The prismaService will automatically route all calls to the currently active transaction
function getMockRootModuleBuilder(): TestingModuleBuilder {
  return Test.createTestingModule({
    imports: [AppModule],
  }).overrideProvider(PrismaService)
    .useValue(prismaService);
}
```

### PrismaTestingHelper
The `PrismaTestingHelper` provides a proxy to the prisma client and manages this proxy.

#### constructor(prismaClient: T)
Create a single `PrismaTestingHelper` per test runner (or a single global one if tests are executed sequentially).
The constructor parameter is the original `PrismaClient` that will be used to start transaction.
Note that it is possible to use any objects that extend the PrismaClient, e.g. a <a href="https://docs.nestjs.com/recipes/prisma#use-prisma-client-in-your-nestjs-services">NestJS PrismaService</a>.
All methods that don't exist on the prisma transaction client will be routed to this original object (except for `$transaction` calls).

#### getProxyClient(): T
This method returns a <a href="https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy">Proxy</a>
to the PrismaClient that will execute all calls inside a transaction.
You can save and cache this reference, all calls will always be executed inside the newest transaction.
This allows you to e.g. start your application once with the ProxyClient instead of the normal client
and then execute all test cases, and all calls will always be routed to the newest transaction.

It is usually enough to fetch this once and then use this reference everywhere.

#### startNewTransaction(opts?: { timeout?: number; maxWait?: number}): Promise\<void\>
Starts a new transaction. Must be called before each test (and should be called before any query on the proxy client is executed).
You can provide timeout values - note that the transaction `timeout` must be long enough so that your
whole test case will be executed during this timeout.

You must call `rollbackCurrentTransaction` before calling this method again.

#### rollbackCurrentTransaction(): void
Ends the currently active transaction. Must be called after each test so that a new transaction can be started.

## Limitations / Caveats
* [Fluent API](https://www.prisma.io/docs/concepts/components/prisma-client/relation-queries#fluent-api) is not supported.
* Sequences (auto increment IDs) are not reset when transaction are rolled back. If you need specific IDs in your tests, you can 
  <a href="https://stackoverflow.com/a/41108598">reset all sequences by using SETVAL</a> before each test.
* `@default(now())` in your schema (e.g. for a `createdAt` date) or similar functionality (e.g. `CURRENT_TIMESTAMP()` in PostgreSQL) will always use the **start of transaction** timestamp. Therefore, all `createdAt`-timestamps will have the same value during a test (because they are executed in the same transaction). If this behavior is problematic (e.g. because you want to find the latest entry by creation date), then you can use `@default(dbgenerated("statement_timestamp()"))` instead of `@default(now())` (if you do not rely on the default "`createdAt` = time at start of transaction instead of statement" behavior)
* Transactions in test cases are completely supported by using <a href="https://www.postgresql.org/docs/current/sql-savepoint.html">PostgreSQL Savepoints</a>.
  * If you are using parallel transactions (e.g. `await Promise.all(/* Multiple calls that will each start transactions */);`), then they will
    automatically be executed sequentially (otherwise, Savepoints wouldn't work). You do not have to change your code for this to work.
