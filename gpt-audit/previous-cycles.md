# Previous audit cycles — rolling summary

One paragraph per closed cycle. Newest on top. Links point into the dated archive directories; don't rewrite entries after a cycle closes.

---

## 2026-04-06 — first external audit (closed 2026-04-07)

**Source:** `archive-2026-04-06/audit-2026-04-06.md` (GPT, 8 findings across sync correctness, policy, deletes, build reproducibility, auth, state encoding, editor UX, WS hardening).

**Outcome: 6/8 implemented, 2 deliberately deferred.**

| # | Item | Status | Landed in |
|---|------|--------|-----------|
| 1 | Initial-sync content-hash check | ✅ Phase A | plugin `db26525` |
| 2 | Path / file-type policy | ✅ Phase A | plugin `db26525` (`src/path-policy.ts`) |
| 3 | State-key encoding | ✅ Phase A | plugin `db26525` (`encodeURIComponent`) |
| 4 | Delete / tombstone model | ✅ Phase B | server `124a2d7`, plugin `3280be4` |
| 5 | WASM source/artifact sync | ✅ Phase B | monorepo `b18532c` (since absorbed into plugin, see two-repo consolidation) |
| 6 | Auth / secret hardening (Argon2id) | ✅ Phase B | server `124a2d7` with lazy plaintext→PHC migration on first verify |
| 7 | Multi-editor consistency | ⏸ deferred | UX polish, no correctness issue — revisit before public release |
| 8 | WS-token / logging hardening | ⏸ deferred | self-hosted single-user is sufficient — revisit before public release |

**Notable deliberate non-implementations:**
- **Server-side path validation** (part of Item 4) was consciously left to the plugin: on the server `doc_uuid` is opaque transport, path policy is the plugin's domain. Duplicating it in Rust risked drift.
- **Tombstone generation model** (Item 4 Phase 2) was skipped: for single-user with <10 devices the long-retention + anti-resurrection guard is sufficient; generations would solve a problem that doesn't occur in practice here.

**Full detail:** `archive-2026-04-06/claude-response.md`.

**Context for the next audit:** the repo structure the first audit looked at (three-repo split: `vaultcrdt-plugin/` + `vaultcrdt-server/` + legacy `vaultcrdt/` monorepo) has since been consolidated into a clean two-repo layout on 2026-04-07. The legacy monorepo is gone; its Rust crates (`vaultcrdt-{core,crdt,wasm}`) now live directly in `vaultcrdt-plugin/crates/`. Any new audit is looking at a meaningfully simpler layout than the one `archive-2026-04-06/` critiqued.
