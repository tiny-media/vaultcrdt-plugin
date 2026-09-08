# Plugin architecture

This document describes the current plugin source (last source-checked
2026-09-08), not the version installed on a device. See the [changelog](../CHANGELOG.md)
for versioned changes.
Anchors use `file:symbol`; server details belong to the [server architecture](https://github.com/tiny-media/vaultcrdt-server/blob/main/docs/ARCHITECTURE.md).

## What the plugin is

VaultCRDT synchronises Markdown notes between Obsidian vaults using Loro
CRDT documents, with a separate whole-file attachment lane.
It runs inside Obsidian on desktop and mobile and connects to a trusted
server; see the [README](../README.md) for user framing and operating limits.
Entry point: `src/main.ts:VaultCRDTPlugin`.
## Components

**Plugin wiring — `src/main.ts:onload`, `buildAndWireSyncEngine`.** Loads settings, inbox and blob index, registers editor/vault events, and
initialises WASM and the note engine after layout readiness. Device identity
exists before engine construction. Blob catch-up and attachment backfill
follow initial note sync; file-open and metadata-cache events trigger mobile
hydration. Shutdown stops the note engine and cancels hydration timers.

**SyncEngine — `src/sync-engine.ts:SyncEngine`.** Owns WebSocket authentication, reconnect/backoff, heartbeat, request waiters,
initial reconciliation and live broadcasts. Delegates initial reconciliation
to `src/sync-initial.ts:runInitialSync` and local changes to
`src/push-handler.ts:PushHandler`. Broadcast processing is serialised;
startup broadcasts are buffered with count/byte bounds and one overflow resync.

**BlobUploader — `src/blob-uploader.ts:BlobUploader`.** Queues local attachment changes, waits for stable size, hashes bytes and
uploads before publishing a path reference. Upload concurrency is one on
mobile and two on desktop. Handles renames, tombstones, quota pauses and
registry catch-up; `lastRemoteHash` suppresses upload echoes.

**BlobDownloader — `src/blob-downloader.ts:BlobDownloader`.** Fetches range segments, assembles bytes in memory, verifies BLAKE3 and writes
through the adapter. Desktop hydration is eager, smallest first, with two
workers; mobile attachments are selected from open-note links with one worker.
Category files hydrate eagerly on both. `hydrated` becomes true only after
successful writing; the echo baseline is installed before the write.
Its inflight count covers admitted downloads through local processing/write
completion, including category files, not queued work or individual HTTP requests.
`publishActiveCount` isolates observer exceptions from hydration. The plugin
renders this count independently of connection state; `StatusPanelModal`
subscribes while open and updates only its download row. Shutdown suppresses
publication before awaiting teardown; it does not cancel ongoing downloads.

**BlobIndex — `src/blob-index.ts:BlobIndex`.** Maps raw vault paths to canonical keys, hashes, sizes, generations, sequence
numbers, hydration/skipped flags and remote hash baselines. New updates and
moves require a WASM path key. JSON writes are serialised; loading validates
basic field types but does not re-run canonical path validation.

**EditorIntegration — `src/editor-integration.ts:EditorIntegration`.** Reads open Markdown editor buffers before relying on disk. Applies Loro text
diffs as editor transactions, converting codepoint offsets to UTF-16;
whole-text editor or vault writes cover other cases. Remote-write and
editor-update guards suppress echoes. The unseen-disk preservation hook is
an explicit broadcast-only option, not a general property of every write.

**FileWatcher — `src/file-watcher.ts:scanForExternalChanges`.** The desktop focus scan compares disk and CRDT text only for already-loaded
documents; it never creates documents. Unchanged mtime/size skips a read as
a desktop heuristic, not as a sync-direction decision. Consequently it is
not a complete detector for edits made while the plugin was closed.

**StartupDirtyTracker — `src/startup-dirty-tracker.ts:StartupDirtyTracker`.** Stores dirty paths in device-local `localStorage`, keyed by vault ID and peer
ID. `src/sync-engine.ts:onFileChanged` and `onFileChangedImmediate` mark paths;
initial sync reconciles them. Missing or inaccessible browser storage leaves
an empty tracker rather than preventing sync.

**StateStorage — `src/state-storage.ts:StateStorage`.** Uses the vault adapter for snapshots and JSON state under the fixed directory
`.obsidian/plugins/vaultcrdt/state`. Snapshot filenames URI-encode the entire
note path. Storage is path-keyed, not server/vault-ID namespaced; connection
replacement therefore needs an explicit state wipe.

**DocumentManager — `src/document-manager.ts:getOrLoad`, `persist`.** Lazily creates and caches WASM documents using the path and stable peer ID,
then imports any saved snapshot. Persists full snapshots, moves path state,
and removes stale documents. Equal plaintext is not used here to manufacture
shared CRDT history.

**Path policy and Rust/WASM — `src/path-policy.ts`, `src/wasm-bridge.ts`.** TypeScript routes note, attachment and category paths; Rust supplies the
canonical blob key. The crate split is precise: `vaultcrdt-core` implements
`blob_path_key`; `vaultcrdt-crdt/src/document.rs:SyncDocument` wraps Loro;
`vaultcrdt-wasm/src/lib.rs` exposes documents, BLAKE3 and SVG sanitisation.
`initWasm` inflates the module embedded in the JavaScript bundle; it does not
fetch executable WASM from the sync server.

**Settings and setup — `src/settings.ts`, `src/setup-modal.ts:submit`.** Hold connection details, credentials, peer/device identity, onboarding state,
status visibility and two opt-in category toggles. Setup supports shared
secrets or invite redemption. `src/main.ts:resetDeviceIdentity` rebuilds the
engine with a fresh peer ID while retaining snapshots and the VV cache.

**Obsidian categories — `src/obsidian-sync.ts:ObsidianSync`.** Uses the undocumented raw vault event plus an adapter-listing sweep because
config files are not ordinary TFiles. Enabling a category hydrates indexed
remote content before sweeping. Missing files generate deletes only for
hydrated, non-skipped entries; listing failures abort the sweep.

**Inbox — `src/inbox.ts:Inbox`.** Persists deduplicated conflict, deletion and failure entries separately from
settings. Startup discovers existing conflict filenames. Dismissal removes
an entry, not its file; deleted files and resolved renames clear linked items.
Discovery notices are throttled to once per five minutes.

**Diagnostics — `src/diagnostics.ts:buildDiagnosticsReport`, `src/logger.ts`.** Reports versions, health, selected settings, state counts and recent issues.
The issue ring holds 50 warnings/errors truncated to 300 characters each.
Exports redact configured secrets and check them before writing and after
readback (`src/main.ts:exportDiagnostics`); paths and device identifiers are
not generally anonymised. Startup traces are a separate export.

## Two lanes

### Notes: causal text state over WebSocket

The wire field `doc_uuid` is the vault-relative path, not a generated UUID
(`src/sync-initial.ts:runInitialSync`, `src/push-handler.ts:onFileRenamed`).
Renames delete the old server path and push the new one; case-only renames
retain local CRDT state. Loro stores text in the `content` container and
derives its numeric peer identity from the configured peer string
(`crates/vaultcrdt-crdt/src/document.rs:SyncDocument::new`, `derive_peer_id`).

Initial sync requests the document list and partitions local/server paths.
It prioritises the active editor. A matching cached server VV with no dirty,
pending or unacknowledged edits skips disk and snapshot reads; dirty matches
compare content hashes before full sync (`src/sync-initial.ts:runInitialSync`).
Full sync exchanges `sync_start`/`sync_delta` and pushes operations missing
from the server VV (`src/sync-initial.ts:syncOverlappingDoc`).

Live `delta_broadcast` handling flushes pending edits, imports the delta,
applies a surgical editor diff where possible and persists state. Missing
VV coverage triggers catch-up. Ordinary shared-history edits merge through
Loro; shared history is tested by overlapping peer keys, not plaintext
equality (`src/sync-engine.ts:onDeltaBroadcast`, `src/conflict-utils.ts:hasSharedHistory`).

Conflict copies preserve local text in these specific cases:

- Missing local CRDT state or disjoint histories: adopt server state, copying
  differing nonblank local text first (`src/sync-initial.ts:syncOverlappingDoc`;
  `src/sync-engine.ts:resolveDisjointHistory`, including `create_conflict`).
- Concurrent external edits at initial sync: differing nonblank server text
  plus local disk divergence produces a copy unless the path was edited live
  during startup (`src/sync-initial.ts:syncOverlappingDoc`).
- Concurrent Excalidraw changes: adopt the remote snapshot and preserve a
  differing nonblank local drawing, rather than merge compressed text
  (`src/sync-engine.ts:resolveExcalidrawConcurrent`; initial overlap handling).
- Startup writes: preserve nonblank disk text differing from both the target
  and the accounted local text (`src/sync-initial.ts:writeServerText`).
- **Broadcast preservation in 0.5.11:** with no open editor, disk text differing
  from both the write target and the pre-import CRDT text gets a conflict copy
  and inbox entry before overwrite. Whitespace-only edits also qualify; the
  hook covers ordinary and VV-gap catch-up writes
  (`src/sync-engine.ts:onDeltaBroadcast`, `src/editor-integration.ts:writeToVault`).

Copies use a date suffix and collision counter, not version-history storage
(`src/conflict-utils.ts:conflictPath`). Remote deletion keeps pending/unacked
or divergent local content and records recreate intent; otherwise it trashes
the file. A tombstoned push refusal probes for live server state before
renaming a retained file (`src/sync-engine.ts:onDocDeleted`, `handleDocTombstoned`).
That handler admits only server-supplied paths accepted by `isSyncablePath`
and re-validates the derived rename destination under the same policy before
calling `renameFile`; frames with a missing or non-string `doc_uuid` are
dropped without any lookup, probe, rename, notice or inbox effect. The
refusal is still NOT correlated with a pending local operation, so a valid
note path can be processed without a prior local push (open work).

### Blobs: content plus a path registry

Bytes are content-addressed by BLAKE3; paths reference hashes separately.
Registry writes include `path_key`, raw `display_path`, `key_version: 1`,
`generation`, live/deleted state, size and `peer_id`. The client increments
its known generation and consumes acceptance/sequence responses
(`src/blob-uploader.ts:reference`, `postPath`, `republishLive`).
Server generation/tiebreak ordering is not implemented or verifiable here;
HTTP 409 is treated as an LWW loss without an immediate upload-side copy.

Catch-up fetches one `since_seq` page with `limit=1000`, records returned
states and advances to the reported `max_seq`; it does not loop over pages
(`src/blob-uploader.ts:runCatchUp`). WS `blob_path_changed` schedules this
HTTP catch-up rather than carrying attachment bytes
(`src/sync-engine.ts:scheduleBlobCatchUp`).

Receive-side registry admission requires a valid key for a new display path;
a known canonical key resolves to the existing local spelling. The code does
not compare the supplied key with the newly computed display-path key
(`src/blob-uploader.ts:applyRemoteLive`). Downloading checks size and transport
hash before writing. Divergent existing attachment bytes get a conflict copy
unless they match `lastRemoteHash`; category files overwrite whole-file,
without JSON-key merging or conflict copies (`src/blob-downloader.ts:hydrateOne`,
`maybeConflictCopy`). An unindexed differing ordinary local attachment is
left alone by registry catch-up (`src/blob-uploader.ts:applyRemoteLive`).

The exact category allowlist is `app.json` and `appearance.json` under
`.obsidian` for settings; direct `snippets/*.css` and
`themes/<theme>/{theme.css,manifest.json}` for styles. Both toggles default off;
workspace files and `plugins/**` are excluded. Current toggles are rechecked
at write-effect decision points; raw display spelling uses TypeScript
lowercasing, whereas canonical keys use full Unicode folding
(`src/path-policy.ts:obsidianSyncCategoryOf`, `isCategoryWriteAllowed`;
`crates/vaultcrdt-core/src/blob_path.rs:blob_path_key`).

## Client-side security boundaries

- Note paths: lowercase `.md` suffix, relative path, no `.obsidian/`, `.trash/`, empty/dot/dot-dot segments or backslashes — `src/path-policy.ts:isSyncablePath`; used at local routing and regular remote note admission.
- Blob paths: structure gate, 1024-byte input bound, NFC → full casefold → NFC and extension/config allowlist; rejects backslashes and trailing segment dots/spaces — `crates/vaultcrdt-core/src/blob_path.rs:blob_path_key`, `src/blob-index.ts:keyFor`.
- Filesystem containment: plugin path gates are the only traversal defence to rely on, not `vault.create`; a recorded desktop measurement on 2026-09-08 found real `create`/`createBinary` writes outside the vault — [measurement](security-review-2026-09-08.md), F2 result; not remeasured here.
- Upload caps: the regular upload path checks stable stat size before reading: images/PDF 10 MiB, audio 25 MiB, category files 2 MiB — `src/path-policy.ts:attachmentCap`, `src/blob-uploader.ts:upload`.
- Receive total cap: claimed/actual download totals are checked against index size and `AUDIO_CAP` (25 MiB), before assembly/copy; no cumulative vault budget or per-type receive cap, and transport already buffers each response — `src/blob-downloader.ts:download`, `sizeAllowed`.
- Blob protocol gate: engine initialised, `blobs` advertised, cached version equal to client version or never reported — `src/main.ts:blobsEnabled`; not a WS-auth-success gate and not checked anew by every `hydrateOne` call.
- SVG receiver boundary: transport hash check, then `sanitize_svg`, then conflict/mkdir/write effects; sanitized bytes become the local hash baseline — `src/blob-downloader.ts:hydrateOne`, `crates/vaultcrdt-wasm/src/lib.rs:sanitize_svg_bytes` (`svg-hush`, standard-image data URLs allowed).
- MessagePack guard: decode failures, non-object/array frames and missing string `type` are logged and dropped before activity/state changes; this is not full payload-schema validation — `src/sync-engine.ts:onMessage`.

These are not universal sink guards: `handleDocTombstoned` now checks source
and destination note policy but still lacks pending-operation correlation.
Other conflict-copy destinations are not revalidated, and persisted blob-index
paths are not recanonicalised on load (`src/sync-engine.ts:handleDocTombstoned`,
`src/conflict-utils.ts:conflictPath`, `src/blob-index.ts:parse`).

## Storage and state

Settings are saved with Obsidian `saveData` in plugin `data.json`, including
plaintext `vaultSecret`/`deviceKey`; there is no encrypted credential store in
this path. The security boundary is access to the device's files, not the
plugin UI (`src/main.ts:saveSettings`, `src/settings.ts:VaultCRDTSettings`).
JWT and one-shot registration admin token are in-memory engine fields
(`src/sync-engine.ts:auth`, `setOneShotAdminToken`).

State comprises URI-encoded `.loro` full snapshots, schema-5 `vv-cache.json`
(VV plus noncryptographic FNV-1a 64-bit content hash), `delete-journal.json`,
`blob-index.json` and `inbox.json`. Dirty paths remain separate in browser
storage (`src/state-storage.ts`, `src/blob-index.ts`, `src/inbox.ts`,
`src/startup-dirty-tracker.ts`). Delete-journal `acked` can mean sent on an open
socket, not server-confirmed (`src/push-handler.ts:PushHandler`).
`StateStorage.cleanOrphans` exempts VV cache, delete journal and inbox, but
not blob index; persistence across that cleanup is not guaranteed by its code.

## Server interface

`src/sync-engine.ts:connect` opens `/ws` with vault/device/peer query metadata.
Its first MessagePack frame is `auth` with the HTTP-issued JWT and
`protocol_version: 1` (`src/protocol.ts:PROTOCOL_VERSION`). It adds
`features: ['blobs']` only when health advertised support; `auth_ok` starts
heartbeat and initial sync. JWT HS256 signing/verification is a server-side
contract, not client cryptography; it cannot be verified from this client.

`src/server-features.ts:ServerFeatureCache` probes `/health`, caches features
and version per server for five minutes, and bounds the probe wait at ten
seconds. Failed probes retain same-server last-known features; an omitted
version retains the previously reported same-server version.

HTTP calls used by the sync/onboarding lanes are:

- `POST /auth/verify`: vault ID and shared secret, optionally one-shot admin
  token; `POST /auth/device`: vault ID, peer ID and device key
  (`src/sync-engine.ts:auth`, `src/setup-modal.ts:submit`).
- `POST /invite` with bearer JWT; `POST /invite/redeem` with invite and device
  metadata (`src/main.ts:openInviteModal`, `src/setup-modal.ts:submit`).
- `POST /vault/blobs/uploads`, `GET`/`PUT /vault/blobs/uploads/{id}`;
  `POST`/`GET /vault/blob-paths`; `GET /vault/blobs/{hash}` with byte ranges
  (`src/blob-uploader.ts:ensureBlob`, `reference`, `runCatchUp`;
  `src/blob-downloader.ts:getRange`). Blob HTTP uses bearer JWTs.

The sibling [vaultcrdt-server repository](https://github.com/tiny-media/vaultcrdt-server)
is not part of this source tree. Its own
[docs/ARCHITECTURE.md](https://github.com/tiny-media/vaultcrdt-server/blob/main/docs/ARCHITECTURE.md)
is authoritative for authentication, registry tiebreaks, persistence and deployment.

## Explicitly not built

- End-to-end encryption is parked; the server receives note content and blob bytes (`src/sync-initial.ts:syncOverlappingDoc`, `src/blob-uploader.ts:putSegment`).
- No metadata obfuscation: wire identities include paths and peer/device metadata (`src/sync-engine.ts:connect`, `src/blob-uploader.ts:reference`).
- No Windows-reserved-name policy (`src/path-policy.ts:isSyncablePath`, `crates/vaultcrdt-core/src/blob_path.rs:blob_path_key`).
