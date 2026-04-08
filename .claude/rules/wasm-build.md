---
description: Regeln fuer wasm/ Artefakte und den Build-Pipeline
globs: wasm/**, scripts/build-wasm.sh, scripts/check-wasm-fresh.sh
---

# WASM-Build Pipeline

## Harte Regeln

- **`wasm/` wird NIEMALS von Hand editiert.** Die Dateien (`vaultcrdt_wasm.js`, `.wasm`, `.d.ts`) sind generiert und committed, aber die Source of Truth ist `crates/vaultcrdt-wasm/`
- **Bit-identisch reproduzierbar**: derselbe `crates/`-Stand muss byte-gleiche `wasm/`-Dateien produzieren. Wenn nicht → Bug, nicht akzeptieren
- **CLI-Version**: `wasm-bindgen` CLI **muss** `0.2.117` sein (matcht `Cargo.toml`-Pin). Mismatch → `wasm:check` meldet Drift im Commit
- **Rebuild-Befehl**: ausschliesslich `bun run wasm` (wrappet `scripts/build-wasm.sh`)
- **Drift-Guard**: `bun run wasm:check` muss vor jedem Commit clean sein

## Wann rebuilden

- Aenderungen in `crates/**` → Rebuild Pflicht
- Aenderungen nur in `src/**` oder `docs/**` → kein Rebuild
- Fresh clone: kein Rebuild noetig (wasm/ ist committed und frisch)
- Unsicher? → `bun run wasm:check` — wenn OK, kein Rebuild

## Scripts nicht leichtfertig anfassen

`scripts/build-wasm.sh` und `scripts/check-wasm-fresh.sh` sind die Vertragsflaeche zwischen Rust und TS. Aenderungen brechen Reproduzierbarkeit. Vor jedem Edit mit dem User Ruecksprache.
