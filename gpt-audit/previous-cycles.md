# Previous audit cycles — rolling summary

One paragraph per closed cycle. Newest on top. Links point into the dated archive directories; don't rewrite entries after a cycle closes.

---

## 2026-04-08/09 — Android initial-sync performance + startup dirty-tracking (closed 2026-04-09)

**Not a GPT-audit cycle** — out-of-band Android bug-chase archived under `archive-2026-04-08-initial-sync-perf/` (`plan.md`, `trace-findings.md`, `android-tests-performance.md`, `android-tests-correctness.md`). Two root causes were separated cleanly: (1) the remaining cold-start delay came from overlapping-file checks, and (2) the failed no-read fast path was self-inflicted because dirty tracking first lived in shared `vv-cache.json` and then got re-poisoned by Android's cold-start `vault modify/create/rename` event flood. **Outcome:** plugin commits `1c6a626`/`33f9f34`/`1aa1153` moved dirty tracking to device-local storage keyed by `vaultId + peerId`, added trace points around startup state and overlapping planning, and ignored Android cold-start vault events until the first `initialSync` finishes. The last good Android trace showed `readsPlanned=0`, `skippedClean=806`, `overlappingMs=3`, `initial-sync.complete` in ~612ms. No server change needed; released as `v0.2.33`.

## 2026-04-07/08 — conflict-storm regression + editor-staleness follow-up (closed 2026-04-08)

**Not a GPT-audit cycle** — out-of-band bug-chase triggered by the `richardsachen` vault producing 805 conflict files. Archived under `archive-2026-04-07-conflict-storm/` (three working docs: `conflict-storm-plan.md`, `conflict-storm-follow-up-plan.md`, `conflict-storm-follow-up-runsheet.md`).

**Root causes (three-layer):**

1. Loro PeerIDs were random per process, so every restart spawned a new per-device VV line. Two devices that "shared" a doc ended up with causally disjoint histories, which Loro then merged as concurrent inserts — doubling the document text on every reconnect.
2. The disjoint-VV merge path called `sync_from_disk(localContent)` on a freshly-created Loro doc when no persisted CRDT state existed. That synthesised a brand-new history that collided with the server's existing history at the next merge.
3. Adopt/conflict decisions in the initial sync read content from `app.vault.read(file)`, which can return stale disk content while an open editor has unsaved keystrokes. Conflict files silently captured the wrong text.

**Outcome:** Fixed in plugin commits `3276d16` (vendor `.claude/`/`.pi/` tooling, align `wasm-bindgen` pin) and `f366dd8` (`derive_peer_id` via BLAKE3 + `set_peer_id()`, adopt-not-merge for Phase 2/3, `readEffectiveLocalContent` editor-first helper, `ensureDeviceIdentity` extract, `PROBE_DOC_UUID`/`PROBE_PEER_ID` constants, five Rust tests + `settings-identity.test.ts` + stale-disk-vs-fresh-editor regression tests). Post-fix CI slip in `071360e` (test file missed the `DocumentManager(app, peerId)` signature change) led to the rule hardening in `589e837` (`.claude/rules/*` now require `bunx tsc --noEmit` before commit).

**No server change needed.** Released as `v0.2.17`.

**Context for the next audit:** the `peerId` lives vault-local in `data.json`, so vault-clone scenarios still inherit duplicate Loro PeerIDs — tracked as pre-community-release work in `memory/project_peerid_clone_caveat.md`.

---

## 2026-04-07 — delete-ack hardening (closed 2026-04-07)

**Not a GPT-audit cycle** — follow-up to the delete-ack gap flagged at the tail of Zyklus 2 ("delete journal is send-based, not ack-based"). Archived under `archive-2026-04-07-delete-ack/` (two working docs: `delete-ack-plan.md`, `delete-ack-second-opinion.md`).

**Problem:** `pendingDeletes` was cleared right after `send()`, so a WS death between send and server commit could drop a delete. On reconnect the path would come back in `doc_list` and be re-downloaded, resurrecting the file.

**Outcome:** Fixed in plugin commit `aa60d60` — the journal is now reconciled against `doc_list` on reconnect (Option B from the plan, no new protocol frame). Entries are only cleared when the server confirms the path as tombstoned (or unknown entirely); still-active paths stay pending for the next retry. No server change needed.

---

## 2026-04-07 — second external audit (closed 2026-04-07)

**Source:** `archive-2026-04-07/audit-2026-04-07.md` (GPT, 6 findings on the newly consolidated two-repo layout: delete races, path-policy gaps, URL/TLS validation, compose secrets, stale READMEs).

**Outcome: 6/6 implemented in a single pass.**

| # | Item | Status | Landed in |
|---|------|--------|-----------|
| 1 | Offline delete/rename resurrection on reconnect | done | plugin `4c8ea7a` — persistent delete-journal, consulted before server-only download in `runInitialSync()` |
| 2 | `doc_delete` bypassed per-document lock (TOCTOU vs `sync_push`/`doc_create`) | done | server `6fe950f` — `DocDelete` now held under the same `DocLocks` |
| 3 | Path-policy gap in initial sync + rename transitions | done | plugin `4c8ea7a` — `isSyncablePath()` applied at source in `runInitialSync()`, rename handler split into all four old/new-syncable transitions |
| 4 | URL/TLS validation via `includes("localhost")` substring trick | done | plugin `4c8ea7a` — central `new URL(...)` parse, enforced in SetupModal + SettingsTab + SyncEngine |
| 5 | `docker-compose.yml` shipped with `change-me-in-production` defaults | done | server `6fe950f` — compose fail-fast via `${VAR:?required}`, example values moved to `.env.example` |
| 6 | Stale READMEs (split + Argon2id claims) | done | plugin + server — corrected WASM-build location, auth model (Argon2id PHC), two-repo layout |

**GPT follow-up review (2026-04-07):** confirmed the fixes sit in the right places and are not cosmetic. Flagged one residual: the delete journal is **send-based, not ack-based** — `pendingDeletes` is cleared right after `send()`, so a WS death between send and server processing can still drop a delete. For self-hosted single-user this is acceptable; harden before a community release (path-specific delete-ack or tombstone-visibility confirmation via `doc_list`).

**Full detail:** `archive-2026-04-07/audit-2026-04-07.md` (audit input); implementation spans plugin commits `4c8ea7a` + `f07c85c` and server commit `6fe950f`.

**Context for the next audit:** after Zyklus 2, the remaining deferred work is (a) the #7/#8 carry-over from Zyklus 1 (multi-editor UX + WS-token logging) and (b) the new delete-ack hardening item above — all three scoped for a pre-community-release block, not the next normal cycle.

---

## 2026-04-06 — first external audit (closed 2026-04-07)

**Source:** `archive-2026-04-06/audit-2026-04-06.md` (GPT, 8 findings across sync correctness, policy, deletes, build reproducibility, auth, state encoding, editor UX, WS hardening).

**Outcome: 6/8 implemented, 2 deliberately deferred.**

| # | Item | Status | Landed in |
|---|------|--------|-----------|
| 1 | Initial-sync content-hash check | done, Phase A | plugin `db26525` |
| 2 | Path / file-type policy | done, Phase A | plugin `db26525` (`src/path-policy.ts`) |
| 3 | State-key encoding | done, Phase A | plugin `db26525` (`encodeURIComponent`) |
| 4 | Delete / tombstone model | done, Phase B | server `124a2d7`, plugin `3280be4` |
| 5 | WASM source/artifact sync | done, Phase B | monorepo `b18532c` (since absorbed into plugin, see two-repo consolidation) |
| 6 | Auth / secret hardening (Argon2id) | done, Phase B | server `124a2d7` with lazy plaintext→PHC migration on first verify |
| 7 | Multi-editor consistency | deferred | UX polish, no correctness issue — revisit before public release |
| 8 | WS-token / logging hardening | deferred | self-hosted single-user is sufficient — revisit before public release |

**Notable deliberate non-implementations:**
- **Server-side path validation** (part of Item 4) was consciously left to the plugin: on the server `doc_uuid` is opaque transport, path policy is the plugin's domain. Duplicating it in Rust risked drift.
- **Tombstone generation model** (Item 4 Phase 2) was skipped: for single-user with <10 devices the long-retention + anti-resurrection guard is sufficient; generations would solve a problem that doesn't occur in practice here.

**Full detail:** `archive-2026-04-06/claude-response.md`.

**Context for the next audit:** the repo structure the first audit looked at (three-repo split: `vaultcrdt-plugin/` + `vaultcrdt-server/` + legacy `vaultcrdt/` monorepo) has since been consolidated into a clean two-repo layout on 2026-04-07. The legacy monorepo is gone; its Rust crates (`vaultcrdt-{core,crdt,wasm}`) now live directly in `vaultcrdt-plugin/crates/`. Any new audit is looking at a meaningfully simpler layout than the one `archive-2026-04-06/` critiqued.
