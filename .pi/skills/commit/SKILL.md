---
name: commit
description: Conventional Commit fuer vaultcrdt-plugin. Scope ist wasm, crates[/<name>], plugin, gpt-audit, docs, build, claude, pi. Use when the user asks to commit, /commit, or after a successful change.
---

# Commit (vaultcrdt-plugin)

## Schritte

1. `git status` und `git diff --staged` lesen. Wenn nichts gestaged ist: auch `git diff` lesen
2. Aenderungen analysieren — welcher Bereich? welche Art (feat/fix/chore/docs/refactor/perf/test/revert)?
3. Message bauen: `<type>(<scope>): <description>`
   - **scopes**:
     - `wasm` — wasm/ Artefakte
     - `crates` oder `crates/vaultcrdt-{core,crdt,wasm}` — Rust-Code
     - `plugin` oder `src/<area>` — TypeScript
     - `gpt-audit` — Audit-Zyklen
     - `docs` — README, CLAUDE.md, Handoff
     - `build` — esbuild, scripts/, Cargo.toml
     - `claude` oder `pi` — Coding-Agent-Setup
   - **description**: Imperativ, English, lower-case, kein Punkt am Ende
4. Bei WASM-Bumps: Body-Zeile `built with wasm-bindgen=0.2.117`
5. Dem User Message zeigen + Bestaetigung einholen
6. Gezielt `git add <file>` (kein blindes `-A`), dann commit

## Critical

- **Niemals** `--no-verify`
- Keine secrets, `.env`, private keys im Commit
- **Crates + wasm/ zusammen committen** — sonst meldet `bun run wasm:check` in der naechsten Session Drift
- Bei Multi-Bereich-Aenderungen: separate Commits bevorzugen
- Wenn `bun run wasm:check` Drift meldet BEVOR committed wird: STOP, erst rebuilden
