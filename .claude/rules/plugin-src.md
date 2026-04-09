---
description: Regeln fuer den TypeScript Plugin-Code unter src/
globs: src/**, esbuild.config.mjs, tsconfig.json, vitest.config.mts, package.json
---

# Plugin Source (TypeScript)

## Build / Test

- **Test-Befehl ist `bun run test`** — NIEMALS Buns eingebauten Test-Runner verwenden (der skippt Vitest still, Tests laufen dann nicht und sehen gruen aus)
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
bunx tsc --noEmit
bun run build
```

Alle drei muessen gruen sein. **`bunx tsc --noEmit` ist Pflicht**, nicht optional:
CI laeuft ihn zusaetzlich zu den Tests, und Vitest-Mocks fangen
Argument-Count-Mismatches nicht ab (gemockte Constructors ignorieren args).
Genau so ist die `DocumentManager`-Signatur-Aenderung in `071360e`
durchgerutscht — die 168 Vitest-Tests waren gruen, erst der tsc im CI hat
sie gefangen.
