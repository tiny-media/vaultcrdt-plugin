---
id: proc-20260408-43ac
type: procedure
title: Rebuild and verify WASM only after crates changes
project: vaultcrdt-plugin
status: active
created_at: 2026-04-08T23:57:38.964504444Z
updated_at: 2026-04-08T23:57:38.964504444Z
salience: 0.8
tags:
- wasm
- rust
- build
related: []
sources:
- CLAUDE.md
- .claude/rules/rust-crates.md
- .claude/rules/wasm-build.md
---

## When to use
Use this after changing crates/** or the Rust↔WASM boundary.

## Steps
1. Run cargo fmt --all and cargo clippy --all-targets --workspace -- -D warnings.
2. Run cargo test --workspace.
3. Run bun run wasm and bun run wasm:check.
4. Run bun run test, bunx tsc --noEmit, and bun run build.
