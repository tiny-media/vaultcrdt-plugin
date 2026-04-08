---
name: deploy
description: Plugin-Deploy zu den lokalen Obsidian-Vault-Pfaden. main.js + manifest.json + wasm/ in die vier Zielordner kopieren. Use only when the user explicitly asks to deploy.
---

# Deploy (Plugin)

Kopiert die gebauten Plugin-Artefakte in die vier Vault-Plugin-Ordner auf dem lokalen Rechner.

## Vorbedingung

```bash
bun run wasm:check        # WASM frisch
bun run test              # Tests gruen
bun run build             # main.js aktuell
```

**Keins darf failen**. Bei Fehler: STOP, dem User sagen.

## Vault-Pfade

Die vier Ziele sind im Memory `reference_deploy` dokumentiert. **Vor dem Kopieren**:

1. Memory lesen: `mcp__memory__memory_get` fuer `reference_deploy`
2. Pfade dem User zeigen und bestaetigen lassen — Memorys sind point-in-time, Pfade koennen veraltet sein
3. Fuer jeden Pfad: pruefen ob `<vault>/.obsidian/plugins/vaultcrdt/` existiert

## Copy

Kopiert werden muessen: `main.js`, `manifest.json`, **und** das gesamte `wasm/`-Verzeichnis.

```bash
for dest in <pfad1> <pfad2> <pfad3> <pfad4>; do
  mkdir -p "$dest/wasm"
  cp main.js manifest.json "$dest/"
  cp -r wasm/. "$dest/wasm/"
done
```

## Verify

```bash
for dest in <pfad1> <pfad2> <pfad3> <pfad4>; do
  ls -la "$dest/main.js" "$dest/manifest.json" "$dest/wasm/vaultcrdt_wasm.wasm"
done
```

## Wichtig

- **Niemals** ohne explizites User-Kommando deployen — das ist ein Seiten-Effekt auf mehrere Vaults
- Server-Deploy (VaultCRDT sync server) laeuft ueber `fleet` aus `~/projects/vaultcrdt-server`, NICHT aus diesem Repo. Nicht verwechseln
- Wenn der User nur "deploy" sagt ohne Kontext: nachfragen ob Plugin oder Server gemeint ist
