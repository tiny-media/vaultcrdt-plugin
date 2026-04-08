---
name: check
description: Voller Guardrail-Check fuer vaultcrdt-plugin — WASM-Drift, Vitest, Build, Cargo fmt/clippy/test. Use before commits or when the user asks to check, validate, or verify.
---

# Check (vaultcrdt-plugin)

Fuehre alle Quality-Gates aus und berichte Status.

## Schritte

1. `bun run wasm:check` — Drift-Guard gegen committed `wasm/`
2. `bun run test` — Vitest (**nicht** `bun test`)
3. `bun run build` — esbuild → `main.js`
4. `cargo fmt --all -- --check`
5. `cargo clippy --all-targets --workspace -- -D warnings`
6. `cargo test --workspace`

## Bei Fehlern

- **`wasm:check` Drift**: NICHT automatisch rebuilden. Dem User zeigen und fragen — Drift kann bedeuten:
  - `crates/` geaendert, Rebuild vergessen (→ `bun run wasm`)
  - `wasm-bindgen` CLI-Version falsch (→ `wasm-bindgen --version` pruefen, muss `0.2.117` sein)
  - `wasm/` wurde von Hand editiert (→ Investigation)
- **Vitest-Fehler**: Fehler lesen, Fix vorschlagen, nach Bestaetigung fixen, erneut laufen lassen
- **Clippy-Warnings**: als Fehler behandeln (`-D warnings`)
- **`cargo fmt` failt**: `cargo fmt --all` anbieten

## Output

Kurz-Report: welche Steps liefen, welche failten, was blockiert einen Commit.
