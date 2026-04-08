# WASM Rebuild

Rebuild der WASM-Artefakte aus `crates/`. Nur antippen wenn `crates/` geaendert wurde.

## Vorbedingung pruefen

```bash
git status crates/
bun run wasm:check
```

- Wenn `wasm:check` OK ist und `crates/` clean: STOP, kein Rebuild noetig — dem User sagen
- Wenn `crates/` Aenderungen hat ODER `wasm:check` Drift meldet: weiter

## Build

```bash
bun run wasm
bun run wasm:check
```

## Verifikation

```bash
git diff --stat wasm/
```

- Diff zeigen, dem User erklaeren was sich geaendert hat
- Wenn `wasm/vaultcrdt_wasm.js` oder `.d.ts` sich geaendert hat: pruefen ob TS-Aufrufseite (`src/`) angepasst werden muss
- Test-Lauf: `bun run test`

## Wichtig

- `wasm-bindgen` CLI muss Version `0.2.117` sein. Pruefen mit `wasm-bindgen --version`. Bei Mismatch: STOP, dem User sagen — sonst entsteht Drift die im Commit sichtbar wird
- Build muss bit-identisch reproduzierbar sein. Wenn dasselbe Input zu unterschiedlichem Output fuehrt: das ist ein Bug, nicht akzeptieren
- `wasm/` niemals von Hand editieren
