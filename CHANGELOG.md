# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.1.1] - 2022-05-13
### Fixed
- Proxied `$transaction<R>(queries: PrismaPromise<R>[]): Promise<R[]>` API now correctly returns `Promise<R[]>` instead of `Promise<void>`

## [0.1.0] - 2022-05-02
### Added
- Initial release
