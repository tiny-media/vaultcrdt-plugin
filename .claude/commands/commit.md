# Guided Conventional Commit

## Vorgehen

1. `git status` und `git diff --staged` (falls leer auch `git diff`)
2. Aenderungen analysieren — welcher Bereich? welche Art?
3. Message bauen: `<type>(<scope>): <description>`
   - **types**: feat, fix, chore, docs, refactor, test, perf, revert
   - **scopes**:
     - `wasm` — Aenderungen an `wasm/` Artefakten
     - `crates` oder `crates/<name>` — Rust-Code
     - `plugin` oder `src/<area>` — TypeScript Plugin
     - `gpt-audit` — Audit-Zyklen
     - `docs` — README, CLAUDE.md, next-session-handoff.md
     - `build` — esbuild, scripts/, Cargo.toml
     - `claude` oder `pi` — Coding-Agent-Setup
   - **description**: Imperativ, English, lower-case, kein Punkt am Ende
4. Message zeigen + Bestaetigung einholen
5. Gezielt `git add <file>` (kein blindes `-A`), dann `git commit`

## Critical

- **Niemals** `--no-verify`
- Bei Multi-Bereich-Aenderungen: separate Commits
- WASM-Aenderungen brauchen Begleit-Commit aus `crates/` (Reproduzierbarkeit) — sonst flaggt `bun run wasm:check` Drift
- Bei `wasm/`-Bumps: Body-Zeile `built with wasm-bindgen=0.2.117` ergaenzen
