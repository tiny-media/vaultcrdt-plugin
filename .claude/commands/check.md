# Guardrail Check

Voller Quality-Check fuer vaultcrdt-plugin (Rust + TS Hybrid).

## Befehle (in Reihenfolge)

```bash
bun run wasm:check        # 1. WASM-Drift gegen crates/
bun run test              # 2. Vitest (NICHT `bun test`)
bun run build             # 3. esbuild → main.js
cargo fmt --all -- --check
cargo clippy --all-targets --workspace -- -D warnings
cargo test --workspace
```

## Vorgehen

1. Befehle der Reihe nach laufen lassen
2. Bei Fehler: stoppen, Fehler dem User zeigen, Fix vorschlagen, nach Bestaetigung fixen, dann weiter
3. Am Ende kurzer Report: was lief, was failte

## Wichtig

- Bei `wasm:check`-Drift: NICHT automatisch `bun run wasm` ausfuehren — den User fragen, denn Drift bedeutet entweder dass jemand `crates/` geaendert hat (legitim, dann rebuild) oder dass `wasm/` korrupt ist (dann investigation)
- Niemals `bun test` statt `bun run test`
