---
name: deploy
description: Server-Deploy laeuft ueber fleet; Plugin-Deploy per lokaler Datei-Kopie ist deaktiviert, weil Plugin-Updates jetzt ueber BRAT/GitHub Releases laufen. Use when the user asks about deploy paths and distinguish plugin vs server.
---

# Deploy

## Plugin

Plugin-Updates laufen ueber BRAT/GitHub Releases.

Nicht mehr verwenden:

- lokale Vault-Pfade aus alten Deploy-Memorys
- manuelles Kopieren von `main.js`, `manifest.json` oder `wasm/` in Obsidian-Vaults

Wenn der User nach Plugin-Deploy fragt:

1. Darauf hinweisen, dass BRAT der kanonische Weg ist.
2. Sicherstellen, dass der passende GitHub Release existiert.
3. Optional BRAT-Update pruefen lassen: Obsidian -> BRAT -> Check for updates.

## Server

Server-Deploy laeuft ueber `fleet` aus `~/fleet` beziehungsweise den Server-Workflow im Schwesterrepo `../vaultcrdt-server`.

Nicht verwechseln:

- Plugin: BRAT/GitHub Release
- Server: fleet/home stack

## Guardrails

- Kein Server-Deploy oder Restart ohne explizite Freigabe.
- Keine Secrets aus SOPS, `.env` oder Live-Konfiguration ausgeben.
- Bei Plugin-Releases vorher `bun run wasm:check`, `bun run test`, `bun run build` ausfuehren.
