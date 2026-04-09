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

The `wasm-bindgen` crate is pinned to `=0.2.117` in `Cargo.toml`. The `wasm-bindgen` CLI used for the post-cargo step must match that version, or `wasm:check` will report drift.

You normally do not rebuild WASM. Only touch it when something in `crates/` changes. Fresh clones already have a working `wasm/` — no Rust toolchain required for `bun run build`.

## Build + test commands

```bash
bun run test         # Vitest — MUST use this script, not Bun's built-in test runner
bun run build        # esbuild → main.js
bun run wasm         # rebuild WASM from crates/
bun run wasm:check   # verify committed wasm/ is fresh
```

The distinction is load-bearing: Bun's built-in test runner can silently skip the Vitest suite, so this repo must use `bun run test`.

## Where to start each session

1. **Read `next-session-handoff.md`** — it is the living session state
2. **Read `gpt-audit/previous-cycles.md`** for the status of past external audits
3. For the full detail of a closed cycle, descend into `gpt-audit/archive-<date>/`

## gpt-audit/ layout

External audits are organised as one directory per cycle. The top level stays minimal so new audits can land on a clean slate:

```
gpt-audit/
├── README.md                 ← workflow for running a new cycle
├── previous-cycles.md        ← rolling 1-paragraph summary per closed cycle
└── archive-<YYYY-MM-DD>/     ← one directory per completed audit cycle
```

The first cycle (`archive-2026-04-06/`) is closed: 6/8 items implemented, 2 deliberately deferred to a public-release session. See `previous-cycles.md` for the short form.

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

## Coding-agent setup

The repo ships with both Claude Code and pi-coding-agent harnesses:

- `.claude/settings.json` — project-wide permissions + PostCompact/Stop hooks
- `.claude/commands/` — slash commands (`/begin`, `/weiter`, `/end`, `/handoff`, `/check`, `/commit`, `/wasm`, `/audit`)
- `.claude/rules/` — path-scoped rules for `crates/`, `wasm/`, `src/`, `gpt-audit/` (auto-loaded by Claude Code)
- `.claude/agents/reviewer.md` — read-only Sonnet reviewer
- `.pi/SYSTEM.md` + `.pi/settings.json` — pi-coding-agent entry point
- `.pi/skills/` — `commit`, `check`, `wasm-rebuild`, `review`, `deploy`, `audit-cycle`
- `.pi/extensions/pi-ultrathink.ts` — exposes the `verify_plugin` tool (wasm freshness, version sync, wasm-bindgen pin, emoji guard, built-in Bun test-runner misuse guard)

The `verify_plugin` tool is the invariant checker; call it after non-trivial changes and before `/commit`.

## Memory note

This repo's `.agent-memory/` also links `../vaultcrdt-server`.
If server memory changes, rerun `memory-vault reindex` and `memory-vault generate --sync-context-files` here to refresh the linked view.

<!-- BEGIN MEMORY-VAULT MANAGED BLOCK -->
## Managed memory workflow
- Durable project memory lives in `.agent-memory/`.
- Search before architecture, workflow, or coding-rule changes with `memory-vault find <query...>`.
- Read exact items with `memory-vault show <id-or-path>` when a search hit looks relevant.
- Write only reusable long-term knowledge with typed `memory-vault add ...` commands.
- After writing new memory, run `memory-vault reindex` and `memory-vault generate --sync-context-files`.

## Managed memory digest
### Decisions
- Keep startup dirty tracking device-local — why: Dirty state is device-specific rather than shared vault state.
- Keep tombstones sticky until retention expires — why: Sticky tombstones prevent deleted documents from being resurrected during sync.
- Keep shared CRDT crates and WASM build in vaultcrdt-plugin — why: The old monorepo is retired and the stale copied crates were removed from vaultcrdt-server.

### Conventions
- Keep authentication errors generic — why: Specific auth failures would make vault enumeration easier.
- Use bun run test, not Bun's built-in test runner — why: Bun's built-in test runner can silently skip the Vitest suite.

### Procedures
- Read Android startup perf traces — steps: Check start.startup-state-loaded for cacheEntries and localDirty.
- Deploy server via fleet from vaultcrdt-server — steps: Work from the vaultcrdt-server repo.
- Rebuild and verify WASM only after crates changes — steps: Run cargo fmt --all and cargo clippy --all-targets --workspace -- -D warnings.

### Mistakes
- Android cold-start vault events poisoned dirty tracking — prevention: Ignore vault modify/create/rename events until the first initial sync completes on startup-sensitive Android paths.
- Android mtime caused wrong cache and skip logic — prevention: Do not use Android mtime for caching, skip logic, or sync change detection.

### Plans
- None yet.

See `.agent-memory/_generated/MEMORY.md` for the fuller digest and `.agent-memory/_generated/INDEX.md` for the complete index.
<!-- END MEMORY-VAULT MANAGED BLOCK -->




