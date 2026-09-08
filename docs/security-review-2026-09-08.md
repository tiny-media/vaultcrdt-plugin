# Security review 2026-09-08 — findings

Hostile pre-submission security review of vaultcrdt-plugin and
vaultcrdt-server, executed 2026-09-08 against an identity-scrubbed snapshot of
both repositories (scrubbing removed owner metadata only; all source content
was preserved).

## What this is, and what it is not

- Four parallel reviews against an identity-scrubbed snapshot of both repos at
  plugin `0cdebb1` (release 0.5.10) and server `88662d8` (release 0.4.3):
  server auth/authorization, client containment against a hostile server, the
  protocol seam between the two, and supply chain / store compliance.
- All findings are source-based hypotheses. Where the reviewer checked an
  invalidating condition, that check is recorded; where a link in a chain is
  unresolved, that is stated. No exploit was executed, no test run, no server
  started.
- One reviewer model per workstream (GPT-6-astra medium: server authz, supply
  chain; Claude Opus 5 high: client, seam). No adjudication pass, no
  known-positive controls: PRECISION IS UNKNOWN. Some findings below may be
  wrong. The anchors are the evidence; treat every claim as a hypothesis until
  a test pins it.
- Provenance (worker-pi run ids): `d90fb61c` server authz, `ba3a40fc` client,
  `6ae19887` seam, `75a6f369` supply chain. Findings 1, 2 and 3a/3b had their
  headline anchors independently re-read by the coordinating session and
  matched; the rest are reviewer-anchored only.

Path convention: `plugin:` = this repository, `server:` = the sibling
`vaultcrdt-server` repository.

## Priority order (severity × confidence)

| # | Finding | Where | Sev | Confidence |
| --- | --- | --- | --- | --- |
| 1 | Offline edit silently overwritten — no conflict copy, no log | plugin | high | anchors re-read independently |
| 2 | Backslash `doc_uuid` escapes the note-lane path gate | plugin | high | anchors re-read independently |
| 3 | Empty `NOTESYNC_JWT_SECRET`/`ADMIN_TOKEN` pass startup and fail open | server | high | anchors re-read independently |
| 4 | Blob upload admission race exceeds quota | server | high | worker-anchored |
| 5 | Tombstone insert unbounded, no length cap on `doc_uuid` | server | high | worker-anchored (+ nuance below) |
| 6 | SVG sanitisation is sender-side only, disarmable via 413 | plugin | medium | worker-anchored |
| 7 | Protocol-version gate only on the WS note lane; blob lane keeps syncing | seam | medium | worker-anchored |
| 8 | Receiver-side attachment allocation driven by server `Content-Range` | plugin | medium | worker-anchored (attack sequence incomplete in the source report; needs reconstruction) |
| 9 | Abandoned uploads escape quota accounting after 24 h | server | medium | worker-anchored |
| 10 | `.obsidian` allowlist decides on casefolded key, writes raw path | plugin | low | worker-anchored |
| 11 | `doc_uuid` size → `doc_list` amplification for every peer | server | low | worker-anchored |
| 12 | Unbounded `peers` rows block tombstone GC | server | low | worker-anchored |
| 13 | `appearance.json` reaches across the themes/snippets toggle | plugin | low | worker-anchored |
| 14 | MessagePack decode in WS handler has no `try` | plugin | low | worker-anchored |

## The three to test first

**1 — Offline edit is silently overwritten.** `plugin:src/sync-initial.ts:411`:
on startup, a file whose cached VV equals the server VV and that is not
dirty/unacked/pending takes the `vv-clean-skip` branch — the cited branch does not read disk text
(the project's own test `src/__tests__/sync-engine.test.ts:951` "performs ZERO
.loro loads (getOrLoad) on the clean-skip path" pins the no-load part; whether
any OTHER path reads the file is not established). An edit made while Obsidian
was closed (git, Syncthing, external editor) receives no vault event, so the
plugin does not learn of it before the skip decision. The focus scan cannot rescue it
(`plugin:src/file-watcher.ts:44` `if (!doc) continue`). When a peer later
broadcasts a delta, `writeToVault` (`plugin:src/editor-integration.ts:82`)
compares disk content only for equality (`if (current === content) return;`)
and otherwise overwrites. The parallel initial-sync path does the right thing
(`writeServerText`, `plugin:src/sync-initial.ts:44-52`: refuses to bury
differing disk text, creates a conflict copy); the broadcast path does not call
it. The VV cache stores no mtime (`plugin:src/state-storage.ts:6-10`), so the
clean tier has nothing to compare without a read. If this sequence is confirmed by a test, it loses offline edits without any
attacker, contrary to the README promise "You can edit offline; edits merge
when devices reconnect". **Suggested test:** fixture with a persisted cached VV
equal to the server VV and clean dirty/unacked/pending state; simulate restart
WITHOUT generating a vault event (plugin unloaded during the external write);
apply a remote CRDT delta only after initial sync completes; assert the local
edit survives in the note or a discoverable conflict copy — not only in
memory.

**2 — Backslash passes the note-lane gate (filesystem escape unverified).** `plugin:src/path-policy.ts:189-192`
`isSyncablePath` rejects only `''`, `.` and `..` segments. Its sister functions
reject more, with the reason in their own comments: `hasIllegalSegments`
(`plugin:src/path-policy.ts:51-53` "Windows separator inside a POSIX segment
(escape into plugins/) … if (seg.includes('\\')) return true;") and the Rust
`blob_path_key` (`plugin:crates/vaultcrdt-core/src/blob_path.rs:74-78` "would
write into plugins/ on Windows via the adapter"). A server-supplied
`doc_uuid = "..\..\evil.md"` is a single segment for `isSyncablePath` — passes;
`normalizePath` then converts `\`→`/` (the project's own mock documents this:
`plugin:src/__mocks__/obsidian.ts:62-65`), producing real `..` segments AFTER
the gate, reaching `vault.create` (`plugin:src/editor-integration.ts:104`). No
guard in between was found (checked `editor-integration.ts:80-105`,
`sync-initial.ts:40-59`, `sync-engine.ts:753/1142`); the existing traversal
test covers `../`, `./`, `/` but not `\` (`plugin:src/__tests__/path-policy.test.ts:40-49`).
Open: whether Obsidian's own `vault.create` rejects `..` — not decidable from
either tree; passing the plugin gate is established, writing outside the vault
is not. **Two tests:** (a) red test on `isSyncablePath` with the literal
the literal string `..\..\evil.md` (raw, double backslash) expecting `false`, then fix by mirroring the
sister rule; (b) an isolated real-Obsidian adapter test (not the mock) on
desktop platforms asserting no file is created outside a temporary vault.

**3a — Empty `NOTESYNC_ADMIN_TOKEN` fails open at registration.** `server:src/main.rs:15-18` reads both secrets
with `env::var(...).expect("must be set")` — that fails only when UNSET; an
empty string passes. Registration compares `body.admin_token.as_deref().unwrap_or("")`
against the configured value (`server:src/lib.rs:251`) — with an empty
configured token, `constant_time_eq("","")` is true and anyone can register a
new vault. Access to EXISTING vaults does not follow from registration alone.
**3b — Empty `NOTESYNC_JWT_SECRET` would be publicly-known signing material.**
JWT sign/verify both use `EncodingKey::from_secret(secret.as_bytes())`
(`server:src/auth.rs:55-78`); an empty accepted key would let an attacker mint
a token with `sub` = any vault id. VERIFY in a test that the installed
jsonwebtoken version accepts signing/verifying with an empty key and that a
forged token authorises WS access to a disposable known vault before filing
this as exploitable. The shipped `docker-compose.yml:17-18` guards unset AND empty
via `${NOTESYNC_JWT_SECRET:?…}`; the README's plain `docker run` path and the
bare binary do not. Also note `docker-compose.yml:9` publishes `"3737:8080"`
(all interfaces) while the README documents `127.0.0.1:3737:8080` — the two
shipped paths disagree. **Fix is small: reject empty values at startup.**

## Remaining findings, by repo

### plugin

- **SVG sanitisation is sender-side only and disarmable (6).** `sanitize_svg`
  runs only in the upload path (`plugin:src/blob-uploader.ts:325`); the
  receive path writes bytes after a BLAKE3 comparison only
  (`plugin:src/blob-downloader.ts:199` — no sanitize import in that file). The
  upload path's quota gate sits BEFORE the sanitize call
  (`plugin:src/blob-uploader.ts:279-282`), and a server answering uploads with
  413 arms `quotaExceededUntil` (`:379-383`) — so a hostile server can deliver
  an unsanitised SVG (hash self-attested) and suppress the clean-up pass at the
  same time. Originating-device sanitisation (README, `plugin:docs/install-brat.md:66`)
does not protect the RECEIVER against a hostile server; no receiver-side
sanitisation is identified. Severity tempered: Obsidian embeds SVGs via
`<img>`, which does not execute scripts. The 413 disarm step is an optional
attack-chain element, not an independently demonstrated impact.
- **Attachment allocation from `Content-Range` (8).**
  `plugin:src/blob-downloader.ts:250` `const out = new Uint8Array(total);` with
  `total` from the server's `Content-Range`, accepted via
  `Number.isFinite(n) ? n : null` (`:308`). The 10/25 MiB caps are not enforced
  on this receive path. (Finding from the first, truncated client run; anchors
  re-checked, attack prose incomplete in the source report.)
- **`.obsidian` allowlist on folded key, write on raw path (10).** Rust checks
  the allowlist on an NFC+casefolded key (`blob_path.rs:30-38`), TS category
  gates on `toLocaleLowerCase` (`plugin:src/path-policy.ts:74`). A
  `display_path` like `.obſidian/snippets/evil.css` (U+017F) folds to the
  allowed prefix in Rust but matches no TS category — a `.css` write with both
  toggles OFF. Inert unless the raw path resolves to the real `.obsidian`
  (unresolved), but the asymmetry is real.
- **`appearance.json` crosses toggles (13).** It lives in the settings
  category (`plugin:src/path-policy.ts:44`) but carries `cssTheme` and
  `enabledCssSnippets`, is written as whole-file LWW without content check
  (`plugin:src/blob-downloader.ts:199`) — a peer with only "app settings" ON
  can activate local CSS. Contradicts `docs/install-brat.md:72` ("apply
  independently").
- **No `try` around the WS decode (14).** `plugin:src/sync-engine.ts:574-576`
  `decode(...) as Record<string, unknown>` — malformed MessagePack may throw
  at the decode call; the TypeScript casts provide no runtime validation.
  User-visible consequences (silent frame loss vs. handler crash) are
  undocumented.

### server

- **Upload admission race (4).** `server:src/blobs.rs:400`: `drop(conn);`
  precedes the staging-file creation; only afterwards does
  `INSERT INTO blob_uploads` (`:411`) reserve. Concurrent creations can pass
  count/quota checks (`:334-342`) before any row lands — five 25-MiB uploads
  against 25 MiB headroom. No recheck at insertion, no schema constraint
  (checked `004_blob_lane.sql:30`), finalization checks size/hash but not
  aggregate quota.
- **Tombstone insert unbounded (5).** `server:src/db.rs:466-470` inserts a
  tombstone regardless of a preceding document lookup; `doc_uuid` has no length
  or shape validation (`handlers.rs:88`, no CHECK in `001_init.sql`). Nuance:
  the insert is an `ON CONFLICT(vault_id, doc_uuid) DO UPDATE` — the same UUID
  twice does not grow; DISTINCT UUIDs do. Cleanup is age-gated, not
  admission-controlled.
- **Abandoned uploads escape accounting (9).** Open-count and quota queries
  only see uploads from the last 24 h (`blobs.rs:344`, `:383`); expired files
  are removed only when their id is touched again (`:447`, `:533`). No sweeper
  in the startup tasks (`main.rs:22-65`).
- **`doc_uuid` amplification (11).** A ~40-MiB `doc_create` (only ceiling: the
  50-MiB frame check, `ws.rs:246`) is stored and re-served to every peer in
  subsequent `request_doc_list` responses while the record remains
  (`db.rs:322` — no filter); the reviewed CLI commands include no
  document-delete (`cli.rs:9-14`) — removal may still be possible by other
  means.
- **Unbounded `peers` rows (12).** `?peer_id=` from the WS query is upserted
  raw (`ws.rs:229`, `db.rs:600`); rows with `last_seen_at <= deleted_at` block
  `expire_tombstones` (`db.rs:637`) for as long as such rows remain eligible.

### seam (both repos)

- **Protocol gate covers only the WS lane (7).** On
  `protocol_version_mismatch` the server closes the socket
  (`server:src/ws.rs:180-188`), the client shows a notice — but
  `syncEngineInitialized` is set BEFORE auth (`plugin:src/main.ts:500`), and
  `blobsEnabled()` (`plugin:src/main.ts:635`) checks only that flag plus the
  `/health` features list. Result: attachments keep uploading to, and on mobile
  keep downloading from, a server whose protocol was just rejected. JWT is
  minted over plain HTTP `/auth/verify`, independent of the WS
  (`plugin:src/sync-engine.ts:290`) — whether that endpoint is reached over TLS
depends on the deployment's server URL, not on the plugin.

## Observations that are not findings

- Deployment: `server:docker-compose.yml:9` publishes `"3737:8080"` (all
  interfaces) while `server:README.md` documents `127.0.0.1:3737:8080` — the
  two shipped paths disagree about exposure.
- Store compliance looked clean on the checked points: manifest/version
  consistency (0.5.10 across manifest/package/versions.json), no runtime code
  loaded from outside, WASM served from embedded bytes. `check-wasm-fresh.sh`
  compares the whole generated directory (better than expected) but enforces
  no `wasm-bindgen` CLI version, builds without `--locked`, and does not run
  as part of `bun run build` — a store reviewer cannot verify the committed
  `.wasm` was built from the adjacent Rust source without redoing the build.
- No blob garbage collection was identified in the reviewed server snapshot;
  deleted attachments count against the 5 GiB default quota until manual
  cleanup.
- Disproved candidate (kept for the record): FNV-1a hash parity server↔client
  on non-ASCII was suspected to turn every accented-note delete into a
  resurrection — traced and DISPROVED (`server:src/fnv.rs:8` UTF-16 code units
  vs `plugin:src/conflict-utils.ts:60` `charCodeAt`).

## Open questions the source cannot settle

1. Does Obsidian's real `vault.create` reject `..` after normalisation?
   (Finding 2's last link — one test answers it.)
2. Runtime behaviour of the blob conflict-copy collision check
   (`getAbstractFileByPath` staleness between two hydrations).
3. `jsonwebtoken` defaults (algorithm pinning, leeway) — crate internals, not
   in tree.
4. Whether device retirement should end established WS sessions (JWTs carry
   vault identity only, `server:src/auth.rs:49`, and sockets never re-validate
   expiry).
