# Next Session: Continue S4–S5 from Pre-v1.0 Roadmap

## What was done (S5: syncOnStartup removal + smart notifications)

- **`syncOnStartup` Setting entfernt** — Plugin verbindet und synced immer beim Start. Das Setting war gefährlich, weil es bei `false` die WS-Verbindung komplett unterdrückt hat (Client driftet vom Server).
- **Notification-Logik überarbeitet** — `initialSync` Progress-Callback erweitert auf `(done, total, changed)`. Notice erscheint nur noch bei Onboarding oder wenn `changed >= 5` (5+ Docs mit echtem Delta). Im Alltag (800 Docs, alle up-to-date) bleibt der Sync still.
- **Bonus-Fix**: Conflict-Pfade (`continue` in overlapping-doc handling) zählen jetzt korrekt im Progress-Counter mit (vorher übersprungen).
- Tests: 81 grün (2 entfernte `syncOnStartup`-Tests).

## What was done (S1–S3 COMPLETE)

Phase 1 (code splitting) is done. All 83 tests pass. New files extracted from `sync-engine.ts`:

| File | LOC | Content |
|------|-----|---------|
| `src/document-manager.ts` | 83 | DocumentManager class (CRDT doc lifecycle + StateStorage) |
| `src/conflict-utils.ts` | 40 | `vvCovers()`, `hasSharedHistory()`, `conflictPath()` |
| `src/promise-manager.ts` | 48 | PromiseManager class (waitFor, resolve, rejectAll) |
| `src/editor-integration.ts` | 184 | EditorIntegration class (writeToVault, applyDiffToEditor, applyToEditor, readCurrentContent, ensureDir) |
| `src/push-handler.ts` | 155 | PushHandler class (onFileChanged, onFileDeleted, onFileRenamed, pushFileDelta, pushDocCreate, flushPendingEdits) |

`sync-engine.ts` is now **705 LOC** (from 1151). It delegates to all extracted modules.

## What needs to be done next

### S4: Test-Splitting (FAILED — needs different approach)

The attempt to share `vi.hoisted()` blocks via a shared mocks file failed because Vitest hoists `vi.mock()` calls per-file and `vi.hoisted()` exports can't cross file boundaries. The split test files were deleted but the original monolithic test files remain and pass.

**Two options for S4:**

**Option A (recommended): Each split test file gets its own `vi.hoisted()` block + `vi.mock()` calls.**
- Copy the ~100 LOC boilerplate into each new test file
- Extract only the helpers (`makeSettings`, `makeApp`, `flush`, `fireMessage`) into a shared file (these DON'T use vi.hoisted)
- The mock objects themselves must be defined per-file via `vi.hoisted()`

**Option B: Skip test splitting.**
- The monolithic test files work fine. The main value was LOC reduction which is less critical for tests.
- Focus on S5 (new tests) instead.

### S4 test split plan (if doing Option A):

Split `sync-engine.test.ts` (1840 LOC) into:
- `sync-engine.auth.test.ts` — 5 tests (auth)
- `sync-engine.sync.test.ts` — 20 tests (initialSync variants, modes, resumable, progress, error, doc_unknown)
- `sync-engine.realtime.test.ts` — 30 tests (onFileChanged, delta_broadcast, editor-level sync, echo guard, conflict fork, VV gap, doc_deleted)
- `sync-engine.misc.test.ts` — 6 tests (isWritingFromRemote, status callbacks, getDocument)

Each file needs its own:
```typescript
const { mockXxx, ... } = vi.hoisted(() => { ... });
vi.mock('obsidian', () => ({ ... }));
vi.mock('@msgpack/msgpack', () => ({ ... }));
vi.mock('../wasm-bridge', () => ({ ... }));
vi.stubGlobal('WebSocket', MockWebSocket);
```

Shared `sync-engine.helpers.ts` (NOT .mocks.ts) exports only:
```typescript
export const makeSettings = (overrides, ...) => ({ ... });
export const flush = async (n = 10) => { ... };
// makeApp and fireMessage need mock references, so they stay per-file OR take params
```

### S5: New tests to write

See original plan for the full list. Key gaps:
- Heartbeat ping interval, stops on close
- Reconnect exponential backoff
- WS request timeout (60s → reject)
- ServerMsg::Error handling
- send() bei geschlossenem WS → silent drop
- import_and_diff fallback → import_snapshot
- Unit tests for `conflict-utils.ts` (vvCovers, hasSharedHistory, conflictPath)
- Unit tests for `promise-manager.ts` (timeout, resolve, rejectAll)
- Unit tests for `document-manager.ts` (roundtrip, missing file, persistAll)

### Phase 4: Config-Hygiene

- `package.json`: `"obsidian": "latest"` → `"obsidian": "^1.8.9"`
- `tsconfig.json`: remove unused `outDir: "dist"`

## Verification after each step

```bash
cd /home/richard/projects/vaultcrdt-plugin && bun run test  # all tests green
cd /home/richard/projects/vaultcrdt-plugin && bunx tsc --noEmit  # pre-existing wasm-bridge error only
```

## Current file sizes

```
705 src/sync-engine.ts
 83 src/document-manager.ts
 40 src/conflict-utils.ts
 48 src/promise-manager.ts
184 src/editor-integration.ts
155 src/push-handler.ts
1840 src/__tests__/sync-engine.test.ts (unchanged)
548 src/__tests__/sync-engine-edge.test.ts (unchanged)
```
