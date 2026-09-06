# AGENTS.md — vaultcrdt-plugin

Obsidian plugin with a Rust/WASM CRDT core (`crates/`, `wasm/`) and an
esbuild/TypeScript frontend (`src/`). The sync server lives in the separate
repo `../vaultcrdt-server`. Local development rules that differ from the
maintainer's global setup live in the untracked `AGENTS.override.md`.

## Session entry and exit

- Enter through `_setup/01-reentry.md` (current focus, state, learnings;
  local, untracked); afterwards read only the files a task touches.
- Exit = distill: update `_setup/01-reentry.md` (what was done, how
  verified, new focus; file stays ≤ 1 page).

## Checks (gate before every commit)

- `bun run test` (vitest) — never `bun test`.
- `bun run build`; plus `bun run wasm:check` whenever `crates/` or `wasm/` changed.
- `cargo test` for the Rust side.
- Capture exit codes bare, never through a pipe.

## Hard invariants

- `wasm/` is the build output of `bun run wasm` — never hand-edited.
- Loro bumps always in lockstep: this repo AND `../vaultcrdt-server`.
- No 32-bit hash as dedup/identity key.
- Android mtime is never sync or cache truth.
- Build/size gates are never loosened as collateral damage.
- Real personal vaults are never test data.
- No secrets, tokens or vault/db raw data in files or answers.

## Working model

- The executing session commits itself, after checks exit 0 and a diff
  review. Worker runs never commit.
- No push/tag/release/deploy without the maintainer's explicit release; no
  irreversible git operations on tracked files — archive to `_setup/_archive/`
  instead.
- One slice per run: no drive-by refactors, no speculative variants without a
  consumer, no new dependency or policy without an order, re-expressions never
  tighten existing bounds.
- Stop and report (never fake "done") when: a migration grows beyond plan, a
  new dependency would be needed, a Loro bump appears, schema/protocol changes,
  a golden/snapshot re-bless, or a scope guard would have to be violated.

## Infrastructure

- Server infrastructure and device-test targets are coordinated through the
  fleet layer (`~/projects/fleet`); applies follow the fleet contract
  (`~/projects/fleet/docs/VERWALTUNG.md` §3.1 — the verbatim clause lives
  in the local untracked `AGENTS.override.md`).
