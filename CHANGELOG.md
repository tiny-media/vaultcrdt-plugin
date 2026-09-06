# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.9] - 2026-09-06

### Added

- Quiet mode (design §E): conflicts, tombstone renames, disjoint conflict
  copies and kept remote deletes now land in a persistent review inbox
  (`state/inbox.json`) instead of interrupting notices; one throttled
  4 s discovery notice per 5 minutes. Progress notices only during the
  first onboarding sync.
- Ribbon status panel: connection state, last server activity, last full
  sync, unconfirmed pushes, inbox count, protocol health, and quick
  actions (Sync now / Invite a device / Export diagnostics / Settings).
  Status bar gains an inbox badge (`·N`).
- Commands `vaultcrdt:open-status-panel` and `vaultcrdt:open-inbox` —
  phones show no ribbon and no status bar, so commands are the mobile
  entry point (command palette or pinned mobile toolbar).
- Diagnostics report includes inbox count and last full sync.

### Fixed

- Inbox entries auto-clear when a kept `(deleted-remote …)` copy is
  renamed away from the pattern; dismissing an entry refreshes ribbon
  tint and status badge immediately.
- Invite modal on tablets: long setup/BRAT URIs wrap instead of
  overflowing the dialog; copy buttons sit in one compact row with the
  value. Status panel buttons meet a 40 px touch target.

## [0.4.8] - 2026-09-06

### Added
- The inviting device mints a one-use invite token server-side (POST
  /invite) and puts it into the setup QR — joining devices need nothing
  but a scan, the vault secret never travels (requires server 0.3.x).
- Official Obsidian ESLint ruleset; release workflow now verifies
  tag/manifest/package versions match exactly and lints before building.
### Fixed
- Invite mint no longer fails when the sync engine is still starting
  (idempotent engine-init wait).
### Changed
- TypeScript pinned to 6.x until typescript-eslint supports 7 (no
  source change; tests, typecheck and build are green on 6).

## [0.4.7] - 2026-09-06

### Added
- Secret-free onboarding when the server supports invites: scanning the
  setup QR is enough — the plugin redeems the one-use invite token and
  stores its own per-device key. The vault secret is no longer pasted on
  joining devices (server 0.3.x required; older servers keep the paste
  flow automatically).
### Fixed
- Server-side hardening shipped in lockstep: invite tokens are hashed
  with SHA-256 and pruned after a day (removes a CPU-DoS surface on the
  redeem endpoint).

## [0.4.6] - 2026-09-06

### Added
- Onboarding: `obsidian://vaultcrdt/setup` links and QR codes. An inviting
  device shows a setup QR (plus a one-click BRAT install link); the joining
  device opens a prefilled modal and only pastes the vault secret — no typing.
  Cancelling any step changes nothing; wiping local sync state happens only
  after an explicit "Join".
### Fixed
- Plugin no longer dies at load on WebViews without `crypto.randomUUID`
  (Chromium < 92, e.g. Amazon WebView 84 on Fire tablets).
- Connect path no longer dies with "TypeError: URL.canParse is not a
  function" on WebViews < Chromium 95.

## [0.4.5] - 2026-09-06

### Fixed
- Startup writes never silently overwrite unaccounted local edits: disk
  content is checked against the cached content hash before any
  initial-sync write; unaccounted changes go to a conflict copy with a
  startup.overwrite-refused trace (U44b — closes the RUN-C/RUN-B2
  data-loss window even for cold, long initial syncs).

### Changed
- Loro 1.13.9 (lockstep with server 0.2.14): snapshot-import checksum
  validation, checkout-hang fix, ~35% faster local text editing; compat
  proven by roundtrip of 1.13.6 blobs.
- wasm-bindgen 0.2.128; vitest 5; TypeScript 7 native tsc (preview
  packages retired); safe dependency round (blake3 1.8.7 et al.).

### Fixed
- U44b: initial sync preserves unaccounted local disk text in a conflict copy
  before writing server text, with a `startup.overwrite-refused` trace mark.

## [0.4.4] - 2026-09-05

### Fixed
- Edits inside the remote-write window are hash-discriminated instead of
  silently dropped (U40); deletes in that window get a deferred decision —
  real deletes journal and propagate, echo patterns are traced and ignored
  (U41). Both device-proven 5/5 after the fix.
- Unacknowledged pushes count as pending for the delete keep-guard: a push
  lost to a half-dead socket no longer lets a remote delete destroy unsynced
  local edits (U42, RUN-B3 S5.2).
- Broadcast-received docs enter the persisted vv-cache (5 s batched flush):
  warm restarts at ~1900 docs no longer fetch every doc individually — the
  139 s initial sync measured in RUN-C collapses to the cache fast path
  (U44a).
- The plugin no longer kills its own healthy socket every ~240 s: the
  activity deadline rises to 90 s (renderer timer stalls measured at >15 s;
  the server's 120 s read-idle close arrives reliably as backstop), and the
  vv-clean-skip refuses only when the path is unacked/pending — O(1), zero
  extra local-doc loads (A1.1 live diagnosis + counter-review amendment).

### Changed
- Diagnostics counts include sent-but-unacked pushes; trace gains
  vault-change.echo-dropped / delete-echo-dropped / delete-remote-suppressed
  / initial-sync.clean-skip-refused marks.

## [0.4.3] - 2026-09-05

### Added
- `Export diagnostics bundle` command: redacted settings, server health
  (version, protocol, latency), warn/error ring buffer (50 entries,
  secret-redacted), state counts, newest trace pointer. The vault secret
  is asserted absent BEFORE the file is written and re-checked after —
  the file is deleted if either gate trips.

### Changed
- WS authentication moved out of the URL: the first frame after connect
  is `auth { token, protocol_version }`, answered by `auth_ok`; the
  server closes unauthenticated sockets (1008) after a bad first frame,
  invalid token or 10 s silence (U02). Friendly notices for rejected
  credentials and version mismatches; no crash-loop (backoff capped).
- `protocol_version` handshake (1): mismatch closes with a clear message
  and the settings health view shows protocol OK / SERVER NEEDS UPDATE /
  CLIENT TOO OLD.
- Logger: warn/error print one pre-formatted, secret-redacted string and
  feed a bounded ring for diagnostics; the vault secret never reaches
  console, ring or files.
- Server URLs with credentials, query strings or fragments are rejected
  at input (setup + settings).
- Disjoint-history broadcasts and `create_conflict` refusals preserve local text in a conflict copy and adopt the server snapshot without merging or pushing unrelated edits (U38/U39).

## [0.4.2] - 2026-09-05

### Added
- Remote delete with unsynced local edits keeps the file and re-creates it
  on the server at the next sync (Bench-C U37) — including a fix so the
  same initial-sync run does not trash what it just rescued.
- A note whose server doc is tombstoned is renamed to
  `<name> (deleted-remote).md` instead of staying silently un-synced
  (Bench-C U29).
- Documented limit: edits made by external tools while Obsidian is closed
  are picked up on the next edit inside Obsidian (Bench-C U36, README +
  recovery runbook).

### Changed
- Broadcasts queued during the initial sync are capped (2 000 entries /
  32 MiB); on overflow the queue is discarded and one extra sync pass runs
  as resync (Bench-C U11).
- `lastRemoteWrite` stores a 64-bit content hash instead of full texts
  (Bench-C U21).

## [0.4.1] - 2026-09-05

### Fixed
- Concurrent-Recreate desselben Pfads verlor serverseitig noch lebenden Inhalt
  (`replace_tombstone` wirkte auch auf lebende Dokumente, Last-Write-Wins) — greift jetzt
  nur noch bei tatsächlich getombstoneten Dokumenten.
- Löschen ist serverseitig atomar (Dokument-Zeile + Tombstone in einer Transaktion);
  ein Absturz dazwischen konnte zuvor Doc ohne Tombstone (oder umgekehrt) hinterlassen.
- Editor-Diff rechnete Codepoint-Offsets (Loro TextDelta) direkt als UTF-16-Positionen
  (CodeMirror) — hinter Emoji/Nicht-BMP-Zeichen landeten Remote-Edits an falscher Stelle.
- Initial-Sync-Fehler meldeten fälschlich „connected" und akzeptierten Vault-Events,
  obwohl `runInitialSync` geworfen hatte.
- Case-only-Rename hinterließ eine zweite Server-Doc-Identität für den alten Pfad —
  sendet jetzt `doc_delete`-Intent für den alten Pfad, ohne das In-Memory-Doc lokal zu
  verwerfen.
- Verwaistes lokales `.loro` mit `version > 0` blockierte dauerhaft den Download eines
  server-only-Dokuments — die Datei wird jetzt trotzdem in den Vault geschrieben.
- Diverse Robustheits-Fixes aus dem Bench-C-Audit: serialisierte Journal-Schreibvorgänge,
  case-insensitive `.obsidian`-Pfadsperre, robusteres malformed-`sync_delta`-Handling,
  Promise-Manager-Races, 50-MiB-Encode-Guard, VV-Cache-Verzeichnis-Anlage beim ersten Sync.

## [0.4.0] - 2026-07-07

### Added
- Pong-/Activity-Deadline: bleibt der Server ≥ 45 s stumm (kein Frame trotz
  Heartbeat-Pings), wird der Zombie-WebSocket aktiv geschlossen und der bestehende
  Reconnect-/initialSync-Pfad heilt die Verbindung (Zug-/Funkloch-Szenario).
- „Reset device identity" (Settings → Advanced, bestätigungspflichtig): frische Peer-ID
  für kopierte/wiederhergestellte Vaults; Notizen und lokale Historie bleiben erhalten.

### Changed
- Content-Hash im Startup-Fast-Path von 32-bit auf 64-bit FNV-1a; VV-Cache-Schema v5,
  ältere Caches werden sicher verworfen (einmaliger voller Abgleich).
- Desktop-Focus-Scan liest nur noch Dateien mit geänderter mtime/size (`cachedRead`)
  statt bei jedem Fenster-Fokus alle geladenen Dokumente voll von Platte.
- esbuild-Target es2018 → es2020 (native BigInt-Literale).
- Release-Build-Profil wiederhergestellt (opt-level=z, lto, strip): WASM 3,33 → 1,86 MB,
  main.js 2,67 MB; CI-Size-Limits zurück auf 3 MB.
- WASM-Initialisierung lazy: `initWasm()` läuft erst mit der Sync-Engine nach
  Layout-Ready statt blockierend in `onload()`; Status-Bar-Wiring ohne Polling.
- Loro 1.13.6 (Lockstep mit Server); Dev-Deps aktuell, TS7/tsgo-Typecheck (`bun run typecheck`).

### Removed
- Toter `EncryptedPayload`-Typ aus vaultcrdt-core.

## [0.3.2] - 2026-06-06

### Added
- Friend/Family-Beta-Dokumente für Mobile-Smoke, Recovery und Restore-Hinweise.
- Sichtbarer Trust-Hinweis im Setup und in den Settings: kein aktuelles Ende-zu-Ende-Encryption-Versprechen.

### Changed
- Aktualisiert: `obsidian` 1.13, `vitest` 4.1.8, `@types/node` 25.9.2 und Loro 1.13 im Rust/WASM-Workspace.
- Typecheck-Baseline für Obsidian 1.13 angepasst.

## [0.3.1] - 2026-05-01

### Changed
- Normalize server URLs during setup and settings edits to avoid double-slash auth and WebSocket paths.
- Show user-visible notices for tombstoned documents and initial-sync conflict copies.
- Clarify that VaultCRDT currently syncs Markdown `.md` files only.

## [0.2.18] - 2026-04-08

### Added
- Setup modal now has a collapsible "Creating a new vault?" section with an Admin Token field. Entering the token lets the plugin register a brand-new vault on the server in a single step — no more out-of-band `curl`.
- Settings → "Reconnect to a different vault" button. Re-runs the setup, re-arms the one-shot admin token if provided, and wipes the local CRDT state when switching to a different vault.

### Changed
- `/auth/verify` 401 error message now points to the admin-token field for users who are trying to register a new vault.
- Admin token is a one-shot credential: held only in RAM, sent with the first `/auth/verify` call, cleared after success, never persisted to disk.

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
