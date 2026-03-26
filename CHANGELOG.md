# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.15] - 2026-03-26

### Changed
- Renamed `registration_key` → `admin_token` in server API (old field name still accepted for backwards compatibility)
- Updated all user-facing strings: "Registration Key" → "Admin Token", "Vault Secret" → "Password"
- Settings now trigger automatic reconnect when server URL, vault name, or password change (debounced 1.5s)
- Renamed `FileWatcherV2` → `FileWatcher` (no V1 exists)
- Extracted initial sync logic from `sync-engine.ts` into `sync-initial.ts` for better maintainability

### Added
- HTTPS/WSS enforcement in Setup modal — insecure connections are blocked (except localhost)
- Server-side vault name validation (lowercase alphanumeric, hyphens, underscores; max 64 chars)

### Removed
- Unused `setDebug()` export from logger

## [0.2.4] - 2026-03-25

### Added
- Sync status indicator in the status bar (`sync ●` / `sync ○`), togglable in settings
- Synced Devices section in settings — shows all devices that have synced with this vault and when they last connected

### Changed
- Renamed internal settings field `apiKey` to `vaultSecret` (automatic migration, no user action needed)
- Plugin now sends `peer_id` in WebSocket query params for server-side peer tracking

## [0.2.1] - 2026-03-19

### Changed
- Updated `obsidian` devDependency from `^1.8.9` to `^1.12.3` (current latest)

### Fixed
- Created proper GitHub Releases (previously only git tags existed)

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
