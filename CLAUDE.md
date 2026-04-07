# vaultcrdt-plugin — Orientation for Coding Tools

## What this is

The Obsidian plugin side of **VaultCRDT**, a self-hosted Obsidian sync using Loro CRDTs.

## Three-repo layout (read this first)

The project started as one monorepo and was split. There are now **three** directories on disk, and knowing which is which is the single most important thing for a new session:

```
/home/richard/projects/
├── vaultcrdt-plugin/     ← YOU ARE HERE — canonical plugin (TypeScript)
├── vaultcrdt-server/     ← canonical Rust/Axum sync server
└── vaultcrdt/            ← historical monorepo, kept ONLY for the WASM build
                            (contains crates/vaultcrdt-{core,crdt,wasm})
```

**Active development happens in `vaultcrdt-plugin/` and `vaultcrdt-server/`.** The `vaultcrdt/` monorepo is legacy — its only live purpose is building the WASM artifacts that land in `vaultcrdt-plugin/wasm/`. Its server crate, Dockerfile, Justfile deploy targets and CI workflow are dead since the March 19 split (cleanup tracked as D1-D7 in `next-session-handoff.md`).

## How the WASM build works

The committed `wasm/` directory in this repo contains `vaultcrdt_wasm.js` + `.wasm` + `.d.ts`. These are reproducible bit-identically from `../vaultcrdt/crates/vaultcrdt-wasm` via `../vaultcrdt/scripts/build-wasm.sh` (writes directly into this repo's `wasm/` dir) and verified via `../vaultcrdt/scripts/check-wasm-fresh.sh`. The `wasm-bindgen` version is pinned to `=0.2.114` in the monorepo Cargo.toml.

You normally do not rebuild WASM. Only touch it when `crates/vaultcrdt-{core,crdt,wasm}/` in the monorepo change.

## Where to start each session

1. **Read `next-session-handoff.md`** — it is the living session state
2. **Read `gpt-audit/claude-response.md`** for the current audit status (Phase A + B done, 6/8 items resolved)
3. **Read `gpt-audit/09-decision-matrix.md`** for the 8-item overview

## gpt-audit/ layout

Structured GPT-authored audit from 2026-04-06 with numbered proposals plus a Claude response documenting what was implemented:

```
gpt-audit/
├── audit-2026-04-06.md               ← original audit
├── 00-change-roadmap.md              ← master plan
├── 01..08-proposal-*.md              ← one file per audit finding
├── 09-decision-matrix.md             ← 8-item status overview
├── 10-minimal-safe-private-release.md
├── 11-public-release-checklist.md
├── 12-risk-register.md
├── claude-response.md                ← Claude's Phase A + B implementation notes
├── next-session-phase-b.md           ← Phase B plan (now historical)
└── README.md
```

## Build + test commands

```bash
bun run test       # Vitest — MUST be `bun run test`, NOT `bun test`
bun run build      # esbuild → main.js
```

The distinction `bun run test` vs `bun test` is load-bearing: `bun test` runs Bun's own test runner and silently skips Vitest tests.

## Deploy

Plugin deploy copies `main.js` + `manifest.json` + `wasm/` to four locations. See the `deploy` skill or the reference_deploy memory. Server deploy is via `fleet` from the sibling `vaultcrdt-server` repo.

## Invariants

- Single user, no backwards compatibility concerns — remove dead code freely
- Android mtime is unreliable, never use for caching or skip logic (bitten by this before)
- LLM-friendly code style: balanced file sizes, no magic, clear structures (see `memory/feedback_code_style.md`)
- All 8 gpt-audit items are tracked to completion (6 done, 2 deliberately deferred until public release)

## Session workflow

- Start with `/begin` which invokes `memory_session_start`
- End with `/end` which closes the memory session
- Current date convention in handoffs: absolute dates, not "tomorrow"
