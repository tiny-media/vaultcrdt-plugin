# vaultcrdt-plugin — Orientation for Coding Tools

## What this is

The Obsidian plugin side of **VaultCRDT**, a self-hosted Obsidian sync using Loro CRDTs. This repo is a **Rust + TypeScript hybrid**: the CRDT engine is Rust compiled to WASM, the Obsidian integration is TypeScript bundled with esbuild.

## Two-repo layout

The project was originally a monorepo, split 2026-03-19, and fully consolidated into two repos on 2026-04-07:

```
/home/richard/projects/
├── vaultcrdt-plugin/     ← YOU ARE HERE — plugin + Rust CRDT engine + WASM build
└── vaultcrdt-server/     ← canonical Rust/Axum sync server
```

The old `vaultcrdt/` legacy monorepo has been retired; its last live role (the WASM build) lives here now.

## Repo layout

```
src/                        # TypeScript plugin source
wasm/                       # Committed WASM artifacts (reproducible, see below)
crates/
├── vaultcrdt-core/         # shared Rust types
├── vaultcrdt-crdt/         # Loro wrapper + merge logic
└── vaultcrdt-wasm/         # wasm-bindgen shell
scripts/
├── build-wasm.sh           # cargo → wasm-bindgen → wasm/
└── check-wasm-fresh.sh     # diff committed wasm/ vs fresh build
Cargo.toml, Cargo.lock      # 3-crate workspace
.cargo/config.toml          # release profile: opt-level=z, lto, strip
rust-toolchain.toml         # stable + wasm32-unknown-unknown
```

## How the WASM build works

`wasm/` contains `vaultcrdt_wasm.js` + `.wasm` + `.d.ts`, **committed**. They are reproducible bit-identically from `crates/vaultcrdt-wasm/` via:

```bash
bun run wasm         # ./scripts/build-wasm.sh — build + write into wasm/
bun run wasm:check   # ./scripts/check-wasm-fresh.sh — drift guard
```

The `wasm-bindgen` crate is pinned to `=0.2.114` in `Cargo.toml`. The `wasm-bindgen` CLI used for the post-cargo step must match that version, or `wasm:check` will report drift.

You normally do not rebuild WASM. Only touch it when something in `crates/` changes. Fresh clones already have a working `wasm/` — no Rust toolchain required for `bun run build`.

## Build + test commands

```bash
bun run test         # Vitest — MUST be `bun run test`, NOT `bun test`
bun run build        # esbuild → main.js
bun run wasm         # rebuild WASM from crates/
bun run wasm:check   # verify committed wasm/ is fresh
```

The distinction `bun run test` vs `bun test` is load-bearing: `bun test` runs Bun's own test runner and silently skips Vitest tests.

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

## Deploy

Plugin deploy copies `main.js` + `manifest.json` + `wasm/` to four locations. See the `deploy` skill or the reference_deploy memory. Server deploy is via `fleet` from the sibling `vaultcrdt-server` repo.

## Invariants

- Single user, no backwards compatibility concerns — remove dead code freely
- Android mtime is unreliable, never use for caching or skip logic (bitten by this before)
- LLM-friendly code style: balanced file sizes, no magic, clear structures (see `memory/feedback_code_style.md`)
- Rust edition 2024, MSRV 1.94
- German docs, English code/comments
- All 8 gpt-audit items are tracked to completion (6 done, 2 deliberately deferred until public release)

## Session workflow

- Start with `/begin` which invokes `memory_session_start`
- End with `/end` which closes the memory session
- Current date convention in handoffs: absolute dates, not "tomorrow"
