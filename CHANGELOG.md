# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.4.0 - 2025-09-16
### Changed
- Savepoints are now released in batches to improve performance (leading to ~15% shorter test execution time in a reference project)
- More detailed error message when trying to execute a query when the corresponding has already been rolled back
- This package now uses Trusted Publishing and provenance on npm

## 1.3.1 - 2025-01-23
### Fixed
- This package now passes the correct `this` context when calling Prisma functions
  - This fixes a bug which caused `Prisma.getExtensionContext(this)` to be `undefined` when writing custom Prisma client extensions

## 1.3.0 - 2024-12-09
### Added
- Added support for Prisma 6

### Removed
- Removed "Transaction changed while executing a query" warning

## 1.2.2 - 2024-11-02
### Fixed
- Using `$queryRaw` with an extended Prisma Client no longer throws a `TypeError`

## 1.2.1 - 2024-11-01
### Fixed
- Calling `const transformedData = await prisma.someTable.findMany().then(data => someTransformation(data))` now correctly returns the transformed data instead of directly returning the `findMany` result

### Changed
- Removed (outdated) source maps from build result

## 1.2.0 - 2024-05-18
### Changed
- Relaxed typing requirement when creating a new `PrismaTestingHelper` so that extended Prisma clients work as well

## 1.1.0 - 2023-07-22
### Added
- Added support for Prisma 5
- Added a warning when the transaction changes (`startNewTransaction` is called) while executing a query 
  (e.g. you forgot to `await` a query in your test, and the next test gets executed while the query is still running)

### Fixed
- Savepoints will now always execute on the correct transaction, even if the query is not awaited and the transaction changes (i.e. `startNewTransaction` is called)
- The proxied function return values now also provide `.catch` and `.finally`, allowing you to use
```ts
const result = await this.prismaService.user.findUniqueOrThrow(/* ... */).catch(/* ... */);
```

## 1.0.0 - 2023-06-17
###  :warning: Breaking Changes
- All statements are now wrapped in an implicit transaction (#2).
  This new behaviour matches PostgreSQL's behaviour and allows parallel transactions as well as failing statements.
  - This might cause a slight performance degradation. Stay on 0.5.0 if you need the better performance and don't rely on implicit statement transactions.
- Dropped support for Prisma versions before 4.7.0 (to ensure interactive transactions are available). Stay on 0.5.0 if you are using an older Prisma version.
- This package now requires Node v14+.
- There is no longer a way to disable transaction locks.

### Fixed
- Transaction rollback no longer silently catches all errors (#4).

## 0.6.0 - 2023-07-22
### Added
- Added support for Prisma 5

## 0.5.0 - 2022-07-06
### Added
- Added support for Prisma 4

## 0.4.0 - 2022-05-19
### Changed
- `$transaction` calls now use an internal lock to prevent multiple transactions from being executed at once (which won't work when using SAVEPOINTS)

## 0.3.0 - 2022-05-19
### Added
- Added <a href="https://www.postgresql.org/docs/current/sql-savepoint.html">PostgreSQL Savepoints</a> around `$transaction` calls

## 0.2.1 - 2022-05-19
### Changed
- Replaced all references to the old package name to `transactional-prisma-testing`

## 0.2.0 - 2022-05-19
### Changed
- License changed to MIT

## 0.1.1 - 2022-05-13
### Fixed
- Proxied `$transaction<R>(queries: PrismaPromise<R>[]): Promise<R[]>` API now correctly returns `Promise<R[]>` instead of `Promise<void>`

## 0.1.0 - 2022-05-02
### Added
- Initial release
