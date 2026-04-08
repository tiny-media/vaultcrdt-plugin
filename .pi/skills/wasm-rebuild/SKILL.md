---
name: wasm-rebuild
description: Guided WASM-Rebuild aus crates/ mit Verifikation. Use when crates/ changed or bun run wasm:check reports drift.
---

# WASM Rebuild

## Vorbedingung

```bash
git status crates/
bun run wasm:check
wasm-bindgen --version
```

- **`wasm-bindgen` CLI muss `0.2.117` ausgeben.** Mismatch → STOP, dem User sagen. Niemals die CLI auf eigene Faust upgraden
- Wenn `wasm:check` OK ist UND `crates/` clean: STOP, kein Rebuild noetig
- Wenn `crates/` Aenderungen hat ODER Drift gemeldet wird: weiter

## Build + Verify

```bash
bun run wasm
bun run wasm:check
git diff --stat wasm/
```

- Diff dem User zeigen
- Wenn `wasm/vaultcrdt_wasm.d.ts` sich geaendert hat: pruefen ob TS-Aufrufstelle (`src/`) mit der neuen API kompatibel ist
- Wenn `wasm/vaultcrdt_wasm.js` sich trivial geaendert hat (nur Whitespace/Bindgen-Metadata): warnen dass das ein Reproduzierbarkeits-Problem sein koennte

## Test

```bash
bun run test
bun run build
```

Beides muss gruen sein.

## Commit-Hinweis

Rebuild-Commits sollten `crates/`-Aenderung und `wasm/`-Delta zusammen enthalten, sonst driftet die Historie. Scope: `feat(crates): ...` oder `fix(wasm): ...` mit Body `built with wasm-bindgen=0.2.117`.
