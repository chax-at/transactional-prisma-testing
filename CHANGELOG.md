# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2023-06-06
###  :warning: Breaking Changes
- All statements are now wrapped in an implicit transaction (#2).
  This new behaviour matches PostgreSQL's behaviour and allows parallel transactions as well as failing statements.
- This package now requires Node v14+.
- There is no longer a way to disable transaction locks.

### Fixed
- Transaction rollback no longer silently catches all errors (#4).

## [0.5.0] - 2023-06-06
### Added
- Added support for Prisma 4

## [0.4.0] - 2022-05-19
### Changed
- `$transaction` calls now use an internal lock to prevent multiple transactions from being executed at once (which won't work when using SAVEPOINTS)

## [0.3.0] - 2022-05-19
### Added
- Added <a href="https://www.postgresql.org/docs/current/sql-savepoint.html">PostgreSQL Savepoints</a> around `$transaction` calls

## [0.2.1] - 2022-05-19
### Changed
- Replaced all references to the old package name to `transactional-prisma-testing`

## [0.2.0] - 2022-05-19
### Changed
- License changed to MIT

## 0.1.1 - 2022-05-13
### Fixed
- Proxied `$transaction<R>(queries: PrismaPromise<R>[]): Promise<R[]>` API now correctly returns `Promise<R[]>` instead of `Promise<void>`

## 0.1.0 - 2022-05-02
### Added
- Initial release

[1.0.0]: https://github.com/chax-at/transactional-prisma-testing/compare/0.5.0...1.0.0
[0.5.0]: https://github.com/chax-at/transactional-prisma-testing/compare/0.4.0...0.5.0
[0.4.0]: https://github.com/chax-at/transactional-prisma-testing/compare/0.3.0...0.4.0
[0.3.0]: https://github.com/chax-at/transactional-prisma-testing/compare/0.2.1...0.3.0
[0.2.1]: https://github.com/chax-at/transactional-prisma-testing/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/chax-at/transactional-prisma-testing/releases/tag/0.2.0
