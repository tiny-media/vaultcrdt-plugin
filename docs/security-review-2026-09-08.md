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

---

# Session appendix 2026-09-08 (security session) — Prüfgrundlage vor S1

Read-only basis for the triage and flow reviews that follow. Nothing above
was rewritten; where this appendix corrects the review text it says so.
Every claim below was measured in this session (commands or file reads at
plugin `fde276b` / server `c7332ba`) unless marked otherwise.

## A. Verified repo state

| Repo | main | Clean | vs origin | Last Security run | Fixes on main, in NO release |
| --- | --- | --- | --- | --- | --- |
| plugin | `fde276b` (0.5.10 `0cdebb1` + security CI + fixes + docs) | yes (`git status --short` empty) | 0/0 | #6 on `fde276b`, success, 2026-09-08T10:42Z | `0f3b78e` (#2 fix), `7bd76cb` (#1 it.fails pin) — `git tag --contains` = 0 tags each |
| server | `c7332ba` (v0.4.3 `88662d8` + `d315afc` + advisory-mode CI) | yes | 0/0 | #5 on `c7332ba`, success, 2026-09-08T09:57Z | `d315afc` (#3 fix) — 0 tags contain it |

Plugin Security jobs: CodeQL javascript-typescript, CodeQL rust (wasm crate),
osv-scanner (bun.lock + Cargo.lock, `continue-on-error` advisory mode),
bun audit (hard), cargo audit (wasm crate, hard), Scorecard. Server Security
jobs: CodeQL rust buildless, `cargo build --locked`, osv-scanner + cargo audit
(both `continue-on-error`, advisory mode).

Correction to the review text above (substance unaffected): the server reads
`VAULTCRDT_JWT_SECRET` / `VAULTCRDT_ADMIN_TOKEN`, not `NOTESYNC_*` (verified
at snapshot `88662d8`, `git show 88662d8:src/main.rs` lines 16/18). Finding
3's mechanism — `.expect()` rejects only UNSET, an empty string passed — was
correct and is fixed on main (`require_non_empty`, `server:src/main.rs`,
rejects unset AND empty, with unit tests).

Gap, named: the GitHub **Security-tab alert lists** (CodeQL + osv SARIF) are
not readable from this session (`gh` unauthenticated here); the advisory
inventory below is reconstructed from the workflow comments, both lockfiles
and `cargo tree -i`. If alert-level adjudication is needed, Richard must open
the tabs or authenticate `gh`.

## B. Deployment under review (live tunnel stack, fleet)

`fleet/hosts/tunnel/stacks/vaultcrdt/compose.yaml`: image
`git.fryy.de/tinymedia/vaultcrdt-server:v0.4.3` (ARM64, private registry),
exposure `kind: public` via `obsidian-sync.tinymedia.de` (Cloudflare Tunnel →
traefik entrypoint `tunnel`, middleware `public-secure@file`, NO rate-limit/
compress middleware — langlebiges WSS), **Authelia bypass** (service has its
own auth). Container: `cap_drop: ALL`, `no-new-privileges`, 256 MiB limit,
uid 1000, `VAULTCRDT_TRUST_PROXY=true` (rate-limit key = CF-Connecting-IP,
10 req/60 s), `VAULTCRDT_TOMBSTONE_DAYS=365`, secrets via sops
(`VAULTCRDT_JWT_SECRET`, `VAULTCRDT_ADMIN_TOKEN`). State `./data` = SQLite
`data.db` + blob dir; backup = consistent SQLite dump + restic. Server binds
`0.0.0.0:8080` without TLS — TLS terminates at the edge; the shipped
`docker-compose.yml` publishes `3737:8080` on all interfaces (review
observation above stands for self-hosters).

## C. Roles and tenant boundary (from code, server `c7332ba`)

- **Server operator** — holds `ADMIN_TOKEN` (vault registration via
  `/auth/verify` on new vault_id, `/debug/connections`, `/debug/vault-stats`)
  and `JWT_SECRET` (signs every token; compromise = all vaults).
- **Vault secret holder** (setup device) — `api_key` → argon2 verify → JWT via
  `/auth/verify`.
- **Invited device peer** — invite redeem (`/invite/redeem`, public,
  rate-limited) → `device_key` (32 chars) + JWT; device re-auth via
  `/auth/device` (argon2, `revoked_at IS NULL` check). JWT carries `sub =
  vault_id` ONLY (no peer identity, no role) — every in-vault peer can mint
  invites (`/invite` = VaultAuth + IP rate limit). Peer retirement
  (`DELETE /vault/peers/{peer_id}`) is **admin-token** gated + exact
  `device_name` confirmation (`server:src/lib.rs:345-404` — corrected by
  flow a/b against this session's first draft, re-verified by coordinator
  read).
- **Anonymous** — `/health`, `/invite/redeem`, `/auth/device` (the latter two
  rate-limited 10/60 s per IP; limiter fails closed at 65 536 keys).
- Tenant boundary = `vault_id` from JWT verification (WS first frame + all
  `/vault/*` routes). WS query `vault_id` parameter is logged but not used
  for authorization (`server:src/ws.rs` auth block).

## D. Protection goals (Schutzgüter)

1. Note contents + attachments — server-side PLAINTEXT (no E2EE; v2 parked).
2. Metadata — paths (`doc_uuid`, `display_path`), peer list, timestamps are
   server-readable; uuid obfuscation deferred to v2.
3. Client secrets — `vaultSecret`/`deviceKey` stored plaintext in plugin
   `data.json` (device boundary = OS user; diagnostics scrub via
   `assertNoSecret`).
4. Server secrets — `JWT_SECRET`, `ADMIN_TOKEN` (operator boundary).
5. Invite tokens — 22 chars from 64-alphabet (≈132 bit), SHA-256-hashed at
   rest, 15 min expiry, single-use.
6. Availability / quota — 5 GiB default per vault, blob storage, SQLite
   durability; DoS surfaces = frame size (50 MiB), auth rate limiter.

## E. Cryptography decisions checked (no change proposed here)

- JWT HS256 (`Header::default()`), 1 h expiry, claims `sub`+`exp` only;
  `Validation::default()` of jsonwebtoken v11 — **algorithm pinning and
  leeway defaults remain Open Question 3 above** (crate internals; to settle
  in S3 from the vendored crate source, not from memory).
- argon2 for vault secrets and device keys (`server:Cargo.toml` `argon2
  0.6.0`); SHA-256 for invite hashes — KDF deliberately dropped for 128-bit
  random tokens (rationale in `server:src/invites.rs:13-16`).
- `constant_time_eq` for admin-token comparisons (3 call sites).
- BLAKE3 both sides for blob content hashing (plugin via wasm `blake3_hex`,
  server `server:src/blobs.rs:620`).
- FNV-1a (UTF-16 code units) tombstone content hash — non-cryptographic
  content match, parity client↔server OBSERVED (disproved candidate, above).
- No TLS in the server itself; no OS-keychain use; E2EE v2 parked with its
  six wire-format rules (Stand-Bericht §4) — not built, not re-litigated here.

## F. Advisory inventory (lockfile-verified 2026-09-08)

Server `Cargo.lock`: `rsa 0.9.10` ← `jsonwebtoken v11.0.0` ← vaultcrdt-server
(`cargo tree -i rsa`, exit 0) — server signs/verifies HS256 only, no RSA
operation in tree (exposure analysis is S3). Plugin `Cargo.lock`: no `rsa`,
no `jsonwebtoken`; shares `loro` chain (`im`, `bitmaps`, `sized-chunks`) and
`atomic-polyfill` with the server. Workflow comments name **7 RustSec
advisories, all transitive, none with fixed versions** (server security.yml
osv job comment). Precise advisory IDs/severities: S3 (local lockfiles +
RustSec DB lookup; cargo-audit not installed locally — installing it would
be a dependency change and needs GO).

## G. Coverage matrix — the five S2 flows vs. prior review

| S2 flow | Prior coverage (2026-09-08 review + fixes) | Open angles for the fresh run |
| --- | --- | --- |
| a) WS authorization per operation | WS auth gate described (seam workstream); no per-operation finding | whether every WS op checks vault scope; peer retirement authz; JWT expiry vs. socket lifetime (Open Question 4) |
| b) Invite lifecycle | none (server-authz workstream raised none) | mint→redeem→expiry→revocation, single-use race (TX looks sound, verify), invite-mint authority = any peer, admin-mint ≠ key rights |
| c) Blob admission + quota | #4 admission race, #9 abandoned uploads, #8 receiver allocation (plugin) | chains end-to-end incl. finalization re-checks; #8's missing attack prose |
| d) Path/blob boundaries | #2 (fixed `0f3b78e`, validation open = F2), #10 casefold asymmetry | display_path leaks, remaining normalisation asymmetries after the #2 fix |
| e) `.obsidian` lane | #13 appearance.json, #10 overlap | toggle semantics vs. path-policy categories, whole-file LWW blast radius |

Scanner alerts: CodeQL SARIF lands in both Security tabs (runs green since
`d7400ce`/`89995ce`); osv findings ride in advisory mode. S2/S3 adjudicate
what the tabs hold (per the gap in A: from workflow output + lockfiles, or
Richard authenticates `gh`).

---

# Session appendix 2026-09-08 (security session) — S1 triage of #4–#14

Method: three glm-5.3-flash (effort low) read-only runs against pinned trees
(plugin `fde276b`, server `c7332ba`; run ids `035e0cb9` server #4/#5/#9/#11/#12,
`7ece5399` plugin #6/#8/#10/#13/#14, `9478fe62` seam #7 — the last exit 6
form-only, report usable). Worker verified anchors; the coordinator re-read
the one anchor the seam worker could not reach (`server:src/ws.rs:179-189`,
mismatch → error frame → close: CONFIRMED) and owns every disposition below.
"Triage erzeugt keine Umsetzung" — nothing here was fixed.

| # | Anchor state | Chain state | Disposition (coordinator) |
| --- | --- | --- | --- |
| 4 | CONFIRMED, but claim overstates: cap is `MAX_OPEN_UPLOADS = 4` (`server:src/blobs.rs:33`), not 5 | race CODE-VERIFIED **and documented as accepted**: `blobs.rs:369-371` "Concurrent creates can overshoot by at most 4 open uploads × 25 MiB; that window is accepted"; finalization checks size+hash, never aggregate quota | **Verwerfen als Hochbefund** (bounded + design-accepted). Optional small hardening: aggregate-quota re-check at finalization → F3 pool |
| 5 | CONFIRMED (`server:src/db.rs:470-476` unconditional insert, no doc_uuid validation in dispatch `handlers.rs:88-107`, no CHECK in `001_init.sql`) | CODE-VERIFIED; `ON CONFLICT(vault_id, doc_uuid) DO UPDATE` semantics confirmed (distinct UUIDs grow, repeats don't) | **Fix-Kandidat (klein)**: length/shape cap on `doc_uuid` at WS dispatch. Requires only synthetic unit test |
| 6 | CONFIRMED (sole `sanitize_svg` call site = upload `plugin:src/blob-uploader.ts:325`; download writes after self-attested-hash compare `blob-downloader.ts:199`; 413 → `quotaExceededUntil` at `:380/:482` gates BEFORE sanitize `:279`) | CODE-VERIFIED; `<img>`-inert tempering stays ASSUMED (Obsidian runtime) | **Fix-Kandidat (klein)**: receiver-side `sanitize_svg` before `writeBinary` — the hash is server-attested, so sender-side-only is no defence against the threat model the review assumed (hostile server) |
| 7 | plugin side CONFIRMED (`main.ts:500` unconditional init, `blobsEnabled()` = flag + health features, no version gate in blob lane, JWT via HTTP `:290`); server side re-read by coordinator: CONFIRMED | full chain CODE-VERIFIED (both sides now) | **Fix-Kandidat (klein)**: gate blob lane on the `/health` protocol_version the probe already parses, or unset `syncEngineInitialized` on mismatch notice |
| 8 | CONFIRMED and narrowed: `Content-Range` total is digits-only (no negative/fractional), `Number.isFinite` redundant, **no upper bound**; upload caps absent on receive path; concurrency 2 (desktop) / 1 (mobile); `hydrateOne` try/catch contains the throw | CODE-VERIFIED | **Fix-Kandidat (klein)**: clamp/reject `total` against the blob-index entry size + a constant cap. Mobile OOM (2 × hostile total) plausible, not demonstrated |
| 9 | CONFIRMED (24 h windows `blobs.rs:344/:383`; delete-on-touch `:450-455`, `:537-542`; hourly task only tombstones+peers, weekly only maintenance) | CODE-VERIFIED; no startup cleanup either (worker checked main.rs only — startup path untested) | **Fix-Kandidat (klein)**: abandoned-upload sweeper in the hourly task + startup sweep |
| 10 | CONFIRMED as asymmetry: Rust allowlist on NFC+casefold (`blob_path.rs:87-89`), TS category on `toLocaleLowerCase('en-US')` (no U+017F fold), write uses RAW display path | CODE-VERIFIED asymmetry; exploit effect INERT unless a filesystem folds `ſ`→`s` (no known FS does; APFS behaviour UNKNOWN, untested) | **Verwerfen** (effect inert without FS folding). Recorded: mobile skips (TS null category), desktop hydrate path's toggle enforcement point is unverified → handed to S2e |
| 11 | core claim WRONG: `list_docs_with_vv` (`server:src/db.rs:313-316`) returns doc_uuid/updated_at/vv only — no snapshot bytes in `doc_list` (`handlers.rs:53-66`) | snapshot amplification exists only via `sync_start` for unknown-vv clients (by design, initial sync); removal IS possible (`WS DocDelete` → `delete_doc_and_tombstone`, `handlers.rs:109-117`) | **Verwerfen** (doc_list amplification disproven). Open remnant for S2c: are document snapshots counted against the 5 GiB vault quota at all? |
| 12 | CONFIRMED with drift (`db.rs:549-562` upsert raw, `db.rs:633-646` NOT EXISTS gate) | CODE-VERIFIED; blocking bounded for idle peers by hourly `expire_stale_peers`; keep-guard semantics documented as "UPPER BOUND, not a guarantee" (`db.rs:611-614`) | **Verwerfen** (design tradeoff; abuser must be an authenticated in-vault peer and harms own vault's GC). Optional: cap `peer_id` length together with #5 |
| 13 | CONFIRMED; doc anchor drifted: "apply independently" sits at `docs/install-brat.md:88`, table at `:92`; category `settings` covers `appearance.json` (`path-policy.ts:44`) | whole-file LWW CODE-VERIFIED (`blob-downloader.ts:199`, comment `:213-215`); the cssTheme/enabledCssSnippets key names are an Obsidian-format fact, not in plugin code | **Fix-Kandidat (Doku, klein)**: disclose that the settings toggle includes theme/snippet activation. Code split (own category) = separate slice, Restliste |
| 14 | CONFIRMED (`sync-engine.ts:575` first line of `onMessage`, no try; `ws.onmessage` `:377-379` synchronous; only msgpack decode site) | CODE-VERIFIED: malformed frame ⇒ uncaught handler error, no reconnect/notice, lane continues on next valid frame | **Fix-Kandidat (klein)**: try/catch + log + drop frame. Synthetic regression test (malformed bytes) possible without any device |

Test-erforderlich-Verdicts: every Fix-Kandidat above is unit/integration
testable with synthetic data only (no device, no tunnel, no invite minting).
No finding among #4–#14 requires a live-system test to disposition.

Unresolved observations handed forward:
- #10/#13: the receive-side enforcement point of the `.obsidian` toggles on
  DESKTOP hydrate was not located by the triage worker (mobile checks
  category, desktop `runHydratePending` returned true unconditionally in the
  read) — S2 flow e must pin this down.
- #11 remnant: document-snapshot quota accounting — S2 flow c.

---

# Session appendix 2026-09-08 (security session) — S3 dependency triage (SCA)

Method: OSV API querybatch against both lockfiles (live, 2026-09-08),
`cargo tree -i` for chains (exit codes captured), crate sources read from
the local cargo registry for jsonwebtoken 11.0.0. No dependency was
changed; every "ignore" below is a PROPOSAL awaiting Richard's GO with the
stated expiry.

## Exact inventory (OSV, both repos)

| Advisory | Crate (version) | Kind | Fixed | Chain (server) | Also in plugin lock |
| --- | --- | --- | --- | --- | --- |
| RUSTSEC-2023-0089 | atomic-polyfill 1.0.3 | unmaintained | none | **stale lock entry** — `cargo tree -i --target all`: "nothing to print" in BOTH repos (not compiled, not reachable) | yes (same stale status) |
| RUSTSEC-2026-0247 | bitmaps 2.1.0 | unmaintained | none | im ← loro-internal ← loro 1.16.0 | yes |
| RUSTSEC-2023-0126 | im 15.1.0 | soundness (aliasing violation in `OrdSet` insertion) | none | loro-internal | yes |
| RUSTSEC-2026-0248 | im 15.1.0 | unmaintained | none | loro-internal | yes |
| RUSTSEC-2023-0071 | rsa 0.9.10 | Marvin Attack, timing side channel (CVSS 3.1 5.9 Medium, AV:N/AC:H/PR:N/UI:N/S:U/C:H) | none | jsonwebtoken 11.0.0, feature `rust_crypto` (optional `dep:rsa`) | **no** (no jsonwebtoken) |
| RUSTSEC-2026-0251 | sized-chunks 0.6.5 | unmaintained | none | im | yes |
| RUSTSEC-2026-0255 | sized-chunks 0.6.5 | soundness (panic-safety unsoundness, UAF/double-free in Chunk/RingBuffer/InlineArray) | none | im | yes |

Server = 7 (matches the workflow comment), plugin = 6 (same minus rsa).

## Exposure assessment

**rsa / RUSTSEC-2023-0071 — no reachable operation.** The server signs and
verifies HS256 exclusively: `Header::default()` (HS256) at signing,
`Validation::default()` = `vec![HS256]` (jsonwebtoken src/validation.rs:161-165),
and decode rejects any header alg outside `validation.algorithms`
(src/decoding.rs:278, :342 — closes alg confusion). `grep -rn "Algorithm::"
server/src/` → rc=1 (no use). The advisory's vulnerable operation (RSA
PKCS#1 v1.5 decryption) is never executed; rsa is compiled in as dead code
because feature `rust_crypto` bundles all backends — jsonwebtoken 11 offers
no hmac-only feature set (features: default=use_pem, rust_crypto, aws_lc_rs;
hmac is optional via rust_crypto only). Timing side channels need the
vulnerable operation to run: exposure = none. Residual risk = future code
starts using RS* algs (no such code exists).

**im family (bitmaps/im/sized-chunks) — latent soundness + maintenance risk
inside the CRDT engine, unresolvable upstream today.** loro 1.16.0 is the
newest release (crates.io, checked 2026-09-08) and still depends on
im 15.1.0. Whether loro-internal's usage touches the affected `OrdSet`
insertion (RUSTSEC-2023-0126) or can panic inside sized-chunks ops
(RUSTSEC-2026-0255) is UNKNOWN without auditing loro-internal — no known
network-reachable trigger exists against loro. If triggered: memory
corruption in the server process (native) / inside the wasm sandbox in the
plugin. The 2026-0247/0248/0251 unmaintained flags are the forward-looking
risk: no maintainer to fix the soundness bugs.

**atomic-polyfill — scanner artifact.** Unreachable in both resolution
graphs; a lockfile regeneration would drop it (needs GO since it touches
Cargo.lock).

## Options (proposal, each needs Richard's GO)

1. **Accept rsa as compiled-dead** with the exposure analysis above recorded
   here; revisit when jsonwebtoken ships a leaner feature set or a fixed
   rsa. Expiry: re-adjudicate at the next jsonwebtoken release or
   2026-12-08, whichever first.
2. **Accept the im family** as carried by loro, tracked: re-run this triage
   on every loro bump (they own the im dependency). Expiry: re-adjudicate
   at the next loro release or 2026-12-08.
3. **Optional cleanup**: regenerate both Cargo.locks to drop the stale
   atomic-polyfill entry (removes 1 of 7 scanner rows; zero code effect).
4. **Not proposed**: patching jsonwebtoken via `[patch]` to strip rsa
   (fragile, version-coupled), or replacing the JWT crate (code change with
   crypto review — no exposure today justifies it).

---

# Session appendix 2026-09-08 (security session) — S2 flow reviews (new findings N1–N19)

Method: five gpt-6 (astra) medium read-only runs, one per control flow, per
the defensive review template (no PoCs, repo-content-as-data, static only;
run ids: a `ca588b46`, b `b670910d`, c `14e35016`, d `ea878c87`, e
`0d33beef`; all exit 0). Cross-flow agreement is high where flows overlap
(a/b on retirement, c/d on key/display binding) — no glm-5.3-max second
opinion was needed (no dispute). The coordinator re-verified the two
context corrections the runs produced (retire = admin token + name
confirmation, `server:src/lib.rs:345-404`; invite mint sits behind the IP
rate limiter) by direct code read. All patches below are UNVERIFIED
proposals from the reviewers.

## Consolidated new findings

| # | Finding | Where | Sev | Confidence | Disposition (coordinator) |
| --- | --- | --- | --- | --- | --- |
| N1 | Retirement does not end membership: JWT (≤1 h + 60 s leeway) keeps full HTTP/WS surface; live sockets unlimited; retired peer's old JWT can still MINT invites → redeem (checks invite only, not inviter) → new permanent device key. Outstanding invites survive retirement. CWE-613 | server | high | high (two flows independently; anchors re-read by coordinator for the retire gate) | **Richard decision**: is retirement a security boundary (stolen-device case) or retention tool (current docs/ops-daily.md:103)? Full fix = device identity in JWT + revocation epoch + socket termination + invite invalidation (design slice). Interim: document the ≤1h mint window |
| N2 | `device_auth` TOCTOU: key hash read under lock → argon2 verify outside → retirement may commit between → JWT minted for a revoked key. CWE-367 | server `invites.rs:198-214` | medium | high static | Fix-Kandidat (small): re-check revoked state after verify, before sign |
| N3 | Device keys without a peers row cannot be retired (redeem creates only device_keys; peers row appears on WS connect; retire 404s without it; empty stored device_name makes confirmation impossible). CWE-841 | server | medium | high | Fix-Kandidat (small-medium): revoke keys independent of retention peers |
| N4 | No invite inventory quota (IP rate limit only, shared across onboarding routes); redeem scan materializes all last-day invites linearly. A leaked invite = permanent vault membership incl. delegation, not 15 minutes. CWE-770 | server | medium | high | Fix-Kandidat (small): per-vault open-invite cap; accept + document the leaked-invite semantics |
| N5 | The 5 GiB quota covers ONLY blobs (+24 h inflight). Documents, VVs, blob-path rows, tombstones are unquota'd → authenticated peer can grow storage unboundedly (50 MiB per frame is not an aggregate cap). REOPENS #11 in corrected form (doc_list amplification itself disproven). CWE-770 | server `handlers.rs:245/349`, `db.rs:254/466` | high | high | Fix-Kandidat (medium slice): total-budget check on snapshot/VV growth |
| N6 | No cumulative receive budget in the plugin: hostile server + many small valid files → unbounded disk + index growth; and no finite download cap (Content-Range total #8 OR plain HTTP-200 full body). CWE-770/400 | plugin | high (vs hostile server) | high | Fix-Kandidat (small-medium): device byte/count budget + finite download cap |
| N7 | Catch-up pagination loses pages: with >1000 pending path states the client adopts the server's global max_seq after ONE page → later states skipped until re-touched. Correctness bug, honest server suffices | plugin+server | medium | high | Fix-Kandidat (small): cursor from processed states, paginate fully |
| N8 | 413 quota pause parks permanently (no timed retry after 60 s); a 413 can also strand an uploaded blob before referencing; delete/rename paths ignore the pause. Availability | plugin | medium | high | Fix-Kandidat (small): timed retry/backoff, scoped park reasons |
| N9 | `path_key`/`display_path` and claimed size are not bound to the actual blob (registration checks each independently; size caps test the CLAIM, not the blob row) → receiver resolves differently than sender; type caps unreliable | server+plugin | medium | high (c+d agree) | Fix-Kandidat (small): server canonicalizes and enforces key==blob_path_key(display), size from blob row |
| N10 | `doc_tombstoned` handler renames a remote-named TFile without any path-policy check (unsolicited tombstone → renameFile of non-syncable existing file possible). CWE-20 | plugin `sync-engine.ts:952-985` | medium | high | Fix-Kandidat (small): gate rename through isSyncablePath + correlate with pending push |
| N11 | Conflict copies: `getAbstractFileByPath` check + async write window (no atomic no-clobber), suffix can exceed the 1024-byte key budget before upload-side rejection. CWE-367/20 | plugin `conflict-utils.ts:68` | medium | medium | Fix-Kandidat (small): no-clobber create + length budget |
| N12 | `hasIllegalSegments` misses control chars / Windows-reserved names (no traversal — portability/alias risk only). Context correction to #2-era assumptions | plugin+server | low-med | high | Verwerfen für Release; note in hardening backlog |
| N13 | Diagnostics export can leak raw display paths (redaction covers secrets, not paths; ring 50×300 units; console uncapped). CWE-532 | plugin | low-med | high | Fix-Kandidat (small, Doku or pseudonymization opt-in) |
| N14 | Persisted blob-index not re-validated on load (old/tampered index data reaches mkdir/writeBinary without a fresh gate). CWE-20 hardening gap | plugin `blob-index.ts:44` | medium | high | Fix-Kandidat (small): re-validate entries at load |
| N15 | Styles/settings toggle OFF does not stop pending or in-flight hydrations (entry indexed under ON; OFF updates settings only) → category file written despite OFF. CWE-863 | plugin | medium | high | Fix-Kandidat (small): check current toggle at write time |
| N16 | Remote tombstones bypass OFF: unskipped category entry + OFF → local file REMOVED (adapter trash), locally-modified file REPUBLISHED without toggle gate. CWE-863 | plugin | medium | high | Fix-Kandidat (small, same slice as N15): gate remove/republish on current toggle |
| N17 | Uploads that passed the gate under ON continue publishing after OFF (no re-check before network effect). CWE-863 | plugin | medium | high | Fix-Kandidat (same slice as N15/N16): re-check before POST/reference |
| N18 | peer_id collision on redeem → SQL constraint error instead of defined 409 (safe rollback, poor UX) | server | low | high | Verwerfen für Release (note) |
| N19 | device_name/peer_id unvalidated → log interpolation (CWE-117) + large metadata rows | server | low | high | Bundle with #5 caps slice (length/charset) |

## Positive confirmations (no finding, recorded to close open questions)

- Invite single-use is race-safe (conditional UPDATE is the FIRST statement
  of the transaction; single mutex-guarded connection; multi-process
  serialized by SQLite write locks) — flow b, and the existing test.
- Broadcast fan-out is vault-scoped on every event type (delta/delete/blob).
- No cross-vault upload/blob access found (same-vault cooperation by design).
- The #10 `.obſidian` chain: NO software remap to the real `.obsidian`
  exists (flow d traced index, pathForKey, sweeps); current server rejects
  the registration outright → #10 disposition "verwerfen (inert)" stands.
- `.obsidian` receive-side toggle enforcement EXISTS at index time
  (`applyRemoteLive` → `categoryDetached` → `skipped:true`) — this closes
  the S1 open question from #10/#13; the gaps are the transitions (N15-N17).
- plugins/** and workspace* stay excluded on BOTH gates (Rust allowlist
  verified; no code-execution surface beyond CSS identified).
- #2's gates hold on all REGULAR entrances (flow d); the ungated sinks are
  NEW paths (N10 tombstone-rename, N11 conflict-copy), not #2 regressions.
- JWT leeway: settled from crate source — `Validation::default()` = HS256
  only + leeway 60 s (jsonwebtoken src/validation.rs:126, :161-165;
  decoding.rs:278/:342 reject foreign algs). Closes review Open Question 3
  for our usage; upper bound on any JWT = exp + 60 s.

## Scanner alerts adjudication

osv/RustSec: adjudicated in the S3 section above (exact IDs, chains,
exposure). CodeQL: both Security tabs are UNREADABLE from this session
(gh unauthenticated; API 401 — measured). Runs are green since `d7400ce`/
`89995ce`, but green upload ≠ zero alerts. **Explicitly out of scope until
Richard authenticates `gh` or eyeballs the tabs**; re-adjudication is a
5-minute follow-up.

## Corrections issued during S2 (already applied above)

- Appendix C: retire = admin token (was: VaultAuth) — corrected.
- Appendix C: `/invite` mint is behind the onboarding IP rate limiter
  (was: listed only redeem/device as rate-limited) — corrected.
- S1 open question (receive-toggle enforcement point): answered (index
  time), see N15-N17 for the actual gaps.

---

# Session appendix 2026-09-08 (security session) — S4 fix slices (all under Richard's GO 2026-09-08)

Process per slice: brief → gpt-6 (astra) medium counter-read (ALL four
first drafts came back REVISE with concrete corrections — anchors, gates,
semantics; every correction was incorporated as v2 before coding) →
opus-cpa-a (low) coded in a pinned worktree → coordinator acceptance:
patch apply on the real tree, ALL gates rerun locally, diff spot-read,
then commit. Evidence: worker run ids F1 `0187bd96`, F3b `72ed1de7`,
F3a `60a9ac4d`, F3c `e1e6450b` (all exit 0); local gate exits below.

| Slice | Content | Commits | Local gates (coordinator rerun) |
| --- | --- | --- | --- |
| F1 (#1) | broadcast path preserves unseen offline edits as conflict copies (pre-import-text discriminator) + inbox entry; pinned it.fails flipped to it() with extended assertions | plugin `a025824` | test 600/600 rc0 · lint rc0 (6 pre-existing warnings elsewhere) · tsc rc0 |
| F3b (#5, #9, N2, N19) | WS identifier caps (doc_uuid 1024 B, peer_id/device 128 B at message, query, invite, auth-device, blob-path ingress), startup+hourly expired-upload sweeper, device_auth revocation recheck after argon2 | server `e657244` | fmt rc0 · clippy -D warnings rc0 · tests 141+2 rc0 |
| F3a (#6, #7, #8, #14) | msgpack decode guard, blob-lane protocol-version gate (absent field = compatible), download caps on all three body paths (AUDIO_CAP + entry.size), receiver-side SVG sanitize before any write effect with sanitized-bytes index baseline | plugin `cb893e3` | test 620/620 rc0 · lint rc0 · tsc rc0 · build rc0 |
| F3c (N15-N17, #13) | effect-time toggle gates (hydrate/tombstone/upload/reference/delete/rename/sweep), OFF→ON resume, doc line on appearance.json | plugin `f065a77` | test 632/632 rc0 · lint rc0 · tsc rc0 |

Red-test evidence: each coder observed its new tests fail before the fix
(details in the worker reports; F3c additionally produced a stash-based
11-red/1-green run of the new suite). Coordinator acceptance included
reading the discriminator placement (F1: pre-import textBefore at all
three write sites), the gate placements (F3a: sanitize after hash check
before any write effect), and the N16 no-removal branch (F3c).

Known residuals carried into the release decision (all named in the
worker reports and code comments): F3a cannot prevent one oversized
response from being buffered by the transport before the cap check
(allocation/write/copy prevented); blob lane does not proactively retry
parked uploads after a protocol mismatch→match transition; the N2
recheck narrows but does not close the revocation race (needs N1
device binding); skipped-state in the index does not distinguish
"toggle off" from quota/422 park reasons.

F2 (validation of #2 against real Obsidian) is PREPARED but BLOCKED on
one manual step: the throwaway vault is registered
(~/Downloads/obsidianTest/vcrdt-t-f2-vault with a self-disabling probe
plugin); the running Obsidian instance ignores obsidian:// URIs for
newly registered vaults, so the vault must be opened once by hand from
the vault switcher. Result lands in
vcrdt-t-f2-vault/_results/f2-probe-result.json. obsidian.json was
backed up before registration (backup-f2 beside it).

---

# Session appendix 2026-09-08 (security session) — S5 disposition matrix + release plan (DRAFT, pending Richard's gate decisions)

Evidence codes: FIXED-THIS-SESSION (slice evidence above) · FIXED-PRE-SESSION (commit cited, tests on main) · DEFERRED (open, decision needed) · REJECTED (disproven/inert/documented-design) · PENDING (blocked on external step). Evidence kind is stated: code-path proof ≠ test reproduction; a negative test does not automatically disprove.

| Finding | Status | Evidence | Residual uncertainty |
| --- | --- | --- | --- |
| #1 offline edit lost | FIXED-THIS-SESSION (a025824) | flipped pin test + 632-test suite (test reproduction, synthetic) | device-level run not repeated (CI tests are the gate); conflict copy on very long paths untested |
| #2 backslash path gate | FIXED-PRE-SESSION (0f3b78e) + F2 PENDING | red test on main (path-policy) | real-Obsidian vault.create behaviour = F2 probe, needs one manual vault open |
| #3 empty secrets | FIXED-PRE-SESSION (d315afc) | unit tests on main | none known |
| #4 upload admission race | REJECTED-as-high (bounded, documented at blobs.rs:369) | code-path proof | aggregate-quota recheck at finalization = backlog |
| #5 doc_uuid unbounded | FIXED-THIS-SESSION (e657244) | cap tests via process_message (test reproduction) | none |
| #6 SVG receiver-side | FIXED-THIS-SESSION (cb893e3) | wasm-real sanitize tests | Obsidian's actual SVG embedding stays ASSUMED (img-inert) |
| #7 protocol gate | FIXED-THIS-SESSION (cb893e3) | gate tests incl. cross-server cache | no proactive retry after mismatch→match (accepted, commented) |
| #8 Content-Range allocation | FIXED-THIS-SESSION (cb893e3) | cap tests on all three body paths | one oversized response still buffers in transport before the cap (allocation/write prevented) |
| #9 abandoned uploads | FIXED-THIS-SESSION (e657244) | sweeper test, two vaults + survivor | failure rows retry hourly (log noise) |
| #10 casefold asymmetry | REJECTED (inert; no software remap — flow d traced) | code-path proof | filesystem aliasing UNKNOWN-but-no-known-FS-folds (U+017F) |
| #11 doc_list amplification | REJECTED (core disproven) / superseded by N5 | code-path proof (db.rs:313-316) | N5 carries the real risk |
| #12 peers block GC | REJECTED (documented keep-guard design, db.rs:611-614) | code-path proof | none |
| #13 appearance.json | FIXED-THIS-SESSION (doc line, f065a77) | doc | code split (own category) = backlog |
| #14 msgpack decode | FIXED-THIS-SESSION (cb893e3) | red→green test | none |
| N1 retirement semantics | **DEFERRED — Richard decision** | two independent flow reviews (a+b) | full fix = device binding design slice |
| N2 device_auth TOCTOU | narrowed FIXED (e657244) | helper unit tests + 3-line wiring (code read) | residual race open until N1; call order not test-proven |
| N3 keys not revocable without peer row | DEFERRED | flow review (static) | — |
| N4 invite inventory quota | DEFERRED | flow review (static) | — |
| N5 documents/VV unquota'd | **DEFERRED — Richard risk decision** | flow c (static, high confidence) | — |
| N6 no cumulative receive budget | **DEFERRED — Richard risk decision** | flow c/d (static) | #8 fix removes the single-request vector; many-small-files vector open |
| N7 catch-up pagination loss | DEFERRED | flow c (static) | — |
| N8 413 permanent park | DEFERRED | flow c (static) | — |
| N9 key/display/size unbound | DEFERRED | flow c+d (static) | — |
| N10 ungated tombstone rename | DEFERRED | flow d (static) | — |
| N11 conflict-copy not no-clobber | DEFERRED | flow d (static) | — |
| N12 control-char policy | DEFERRED (backlog) | flow d | — |
| N13 diagnostics path leak | DEFERRED | flow d (static) | — |
| N14 index not re-validated on load | DEFERRED | flow d/e (static) | — |
| N15-N17 toggle transitions | FIXED-THIS-SESSION (f065a77) | 12-test suite incl. stash-based 11-red/1-green | rename-resume path tested indirectly |
| N18 peer_id collision 500 | REJECTED-for-release (noted) | flow b | — |
| N19 log metadata caps | FIXED-THIS-SESSION (e657244, bundled with #5) | cap tests | — |
| RustSec rsa | accept PROPOSED | crate-source proof (HS256-only, alg pinning) | expiry: next jsonwebtoken release or 2026-12-08 |
| RustSec im-family | accept PROPOSED | lockfile+tree proof, loro 1.16.0 newest | expiry: next loro release or 2026-12-08 |
| atomic-polyfill | stale lock entry | cargo tree --target all "nothing to print" | optional lock regen (GO) |
| CodeQL alerts | PENDING gh auth | API 401 measured | 5-min re-adjudication after auth |

## Release proposal (draft — needs Richard's GO; tags NOT pushed by this session)

- **Plugin 0.5.11** (tag `0.5.11`, NO v-prefix — store rule): F1 + F3a +
  F3c + #13 doc + this review doc. Version bumps: manifest.json,
  package.json, versions.json; CHANGELOG entry. CI parity: local gates
  green (632 tests/lint/tsc/build); CI additionally runs Rust/wasm gates
  (no Cargo/wasm file changed by the slices).
- **Server v0.4.4** (tag `v0.4.4`, WITH v-prefix): F3b. Version bump in
  Cargo.toml (+lock). Deploy chain per reentry (studio build → tunnel →
  fleet, FLEET_ACTOR=vaultcrdt-plugin, ledger commit+push) under a
  separate deploy GO.
- **Not in these releases, explicitly:** N5, N6 (needs Richard's risk
  decision: hold the release or accept for the friends/family beta),
  N3/N4/N7-N14 (backlog slices), N1 (design decision), F2 result
  (pending the manual vault open).

## Remaining gaps, named

This review is source-anchored static analysis plus synthetic tests; it
claims neither completeness nor "secure". Open: CodeQL tab contents (gh
auth), F2 real-Obsidian probe, device-level validation of F1 (one
manual offline-edit scenario on any desktop device would upgrade the
evidence), N5/N6 budget slices, N1 semantics decision, OS-level
filesystem aliasing questions (marked UNKNOWN, no known trigger).

---

# Session appendix 2026-09-08 (security session) — F2 result (Richard opened the throwaway vault 2026-09-08 ~15:54)

**Obsidian's real `vault.create`/`createBinary` does NOT reject traversal
paths — files were written OUTSIDE the vault.** Probe evidence
(desktop, throwaway vault, self-disabling probe plugin; raw result was at
`vcrdt-t-f2-vault/_results/f2-probe-result.json`, probe + vault + the
escaped marker files were cleaned up afterwards; obsidian.json restored
from backup):

- `normalizePath('..\..\evil.md')` → `'../../evil.md'` (backslash
  conversion confirmed — exactly finding #2's mechanism).
- `vault.create('../escape-f2.md', …)`, `vault.create('..\..\evil.md')`,
  `vault.create('sub/../../escape2-f2.md')`,
  `vault.createBinary('../escape3-f2.md')` — ALL returned success
  (`ok:true`; returned TFile is null) and `fs.existsSync` confirmed the
  files landed at `…/obsidianTest/escape*.md`, i.e. one level ABOVE the
  vault root.

Consequences:

1. Finding #2's plugin-side fix (`0f3b78e`, on main, in 0.5.11) is now
   established as the ONLY defense for the note lane — there is no native
   Obsidian safety net behind it. The fix itself holds (gate rejects the
   backslash payload before any write).
2. Open Question 1 of the original review is answered: writing outside
   the vault via `vault.create` WORKS on desktop (Obsidian 1.x,
   appVersion 6b15b73…). "Passing the plugin gate is established,
   writing outside is not" — now it is.
3. N10 (ungated `doc_tombstoned` rename to a remote-named TFile) and
   N11 (conflict-copy sinks without re-validation) are no longer
   theoretical hardening gaps: any remote input reaching those sinks can
   now be assumed to write/rename outside the vault on desktop. Their
   DEFERRED disposition stands only with this elevated rationale;
   pulling N10 into the current release is recommended to Richard
   (small slice: gate the rename through the path policy + correlate
   with a pending push).
4. Evidence kind: direct test reproduction on the real application
   (desktop macOS), synthetic content, throwaway vault. EVIDENZART:
   Testreproduktion am echten Obsidian-Desktop.

(One probe artifact noted: `obsidianVersion` came back null — the
appVersion field is not exposed the way the probe assumed; the hash
6b15b73d12694dada2ed1418d3ed507b was captured instead.)

---

# Session appendix 2026-09-08 (security session) — direction decisions (astra medium, run ids 2802e5fb / c450e341) and release execution

## N1 — retirement semantics: OPTION (c), full security boundary

The stolen-device adversary is in scope today; (a)/(b) let a retired
device convert temporary access into permanent access (invite minting
survives; only an inviter-status check at redeem would close part of it).
Cheapest (c) design: immutable device-key ID in JWT claims + active/
revoked check on every authenticated request and WS handshake (no
separate epoch needed if replacement credentials get fresh IDs); index
sockets by device-key ID and close them on retirement; bind invites to
the authenticated inviter and check inviter status at redeem; retire
directly from device_keys, idempotent, immutable-identifier confirmation
(empty names no longer block); reject identity-less legacy JWTs at
cutover and disconnect their sockets. Interim operator lever that exists
TODAY: rotating VAULTCRDT_JWT_SECRET invalidates every token instantly
(all devices re-auth). Effort M-L; scheduled as a design slice, not in
0.5.11/v0.4.4. Residual (accepted by the choice): retirement cannot
erase notes already copied, and cannot remove a device the thief
enrolled before retirement without a separate retire.

## N5/N6 — soft-cap ladders (design parameters, UNMEASURED proposals)

N5 server (≈ 9–16 days total): per-vault document budget 512 MiB
(snapshot bytes in place, not cumulative) + 10 000 documents; ladder
80/95/100 % = one-time notice / persistent warning + daily reminder /
refuse only growth-causing operations (reads, deletes, equal-or-smaller
snapshots and metadata upkeep keep working); HTTP 413 quota_exceeded +
versioned WS storage_status; atomic counter upkeep (new−old size) with
periodic reconciliation; plugin copy must become class-specific (today's
says attachments generally). Sharpen only with compatible client error
handling (v0.4.5 + 0.5.12 together).
N6 device (≈ 5–8 days, own slice after N5): per-device receive governor,
defaults 1 GiB received blob bytes + 5 000 new paths; same ladder;
atomic reservation before download/index insert, conservative reservation
up to the 25 MiB single-item cap when size unknown; blocked paths held
as bounded cursors, not unbounded pending lists; note sync continues;
escape hatch is local-only (raise budget / re-baseline after cleanup),
never a hostile-server-controllable reset.
Not capped for the beta: metadata row counts (visible via stats, cleaned
orphaned rows, admission-coupled); re-examine cardinality/rate limits
before unknown self-hosters arrive.

## S3 — accepts confirmed (family beta)

rsa: accept (S, documentation only; HS256-only reachability). im-family:
accept FOR THE FAMILY BETA with mandatory re-review BEFORE the store
release and at every loro release, at the latest 2026-12-08. Both need a
risk register entry (owner, advisory ids, versions, recheck trigger).
atomic-polyfill: no runtime acceptance needed (unreachable); optional
targeted lock cleanup (S ≤0.5 d, no incidental upgrades).

## Release execution (Richard's GO 2026-09-08)

- Plugin 0.5.11 tagged `0.5.11` (no v-prefix) and pushed (`fde276b..53192ac`);
  Release/CI/Security workflows running on the tag.
- Server v0.4.4 tagged `v0.4.4` and pushed (`c7332ba..ea7e35a`); CI/
  Security/Docker running. The tunnel deployment (studio build → load →
  fleet) awaits a separate deploy GO.
