# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-03-19

### Changed
- Replaced all `console.log` statements with a gated logger — silent in production, enable via debug flag
- Fixed `createDocument()` TypeScript error by passing required `docUuid` and `peerId` arguments to WASM constructor
- Pinned `obsidian` devDependency to `^1.8.9` (was `latest`)
- Removed unused `outDir` from `tsconfig.json`

### Added
- `logger.ts` module — `log()` is gated behind a debug flag, `warn()`/`error()` always active
- Unit tests for `conflict-utils` (17 tests), `promise-manager` (6 tests), `document-manager` (12 tests)
- CI: code coverage reporting via `vitest --coverage`
- CI: build size check (main.js must stay under 3 MB)

### Removed
- `awareness-state.ts` — unused cursor tracking module (will return as a future feature)
- `syncOnStartup` setting (removed in 0.1.x, cleanup finalized)

## [0.1.0] - 2026-03-15

### Added
- Initial release
- Real-time CRDT sync via WebSocket using Loro
- Bidirectional merge with automatic conflict detection
- Conflict copies with `(conflict YYYY-MM-DD)` naming
- Onboarding modal with Pull/Push/Merge mode selection
- Smart sync notifications (only shown when changes exceed threshold)
- WASM CRDT module inlined via esbuild binary loader
- State persistence via `.loro` snapshot files
- Debounced editor change detection
- External file change scanning on window focus
- Settings UI with server health check and storage stats
