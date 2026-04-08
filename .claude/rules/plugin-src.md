---
description: Regeln fuer den TypeScript Plugin-Code unter src/
globs: src/**, esbuild.config.mjs, tsconfig.json, vitest.config.mts, package.json
---

# Plugin Source (TypeScript)

## Build / Test

- **Test-Befehl ist `bun run test`** — NIEMALS `bun test` (Bun-Runner skippt Vitest still, Tests laufen dann nicht und sehen grün aus)
- Build: `bun run build` → `main.js` im Repo-Root (esbuild bundle)
- Dev: `bun run dev` (esbuild watch)

## Obsidian-Pitfalls

- **Android mtime ist unzuverlaessig** — niemals fuer Caching, Skip-Logik oder Change-Detection. Wenn du mtime liest, frag dich erst ob es einen anderen Weg gibt (Hash, Server-Token, explizite Revisions)
- Plugin muss `isDesktopOnly: false` bleiben (Mobile-Support ist Feature)
- Obsidian-API nur ueber die offiziellen Types aus dem `obsidian` Package — keine internen Feld-Pfade

## Code-Style

- LLM-freundlich: ausgewogene Dateigroessen, keine Magie, explizite Strukturen, klare Namen — siehe Memory `feedback_code_style`
- Keine Emojis in Code, Kommentaren oder Log-Messages
- Fehlerbehandlung an Boundaries (WASM-Aufrufe, Obsidian-API, Netzwerk). Internal code trusts its callers
- Single user, kein Backwards-Compat — toter Code darf weg, keine Deprecation-Stubs

## Vor Commits

```bash
bun run test
bun run build
```

Beides muss gruen sein.
