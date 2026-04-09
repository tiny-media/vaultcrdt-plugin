# Session Handoff — v0.3.0 released after Docs-/Memory-Konsolidierung

Datum: 2026-04-09
Branch: `main`
Plugin-Release live: `v0.3.0`
Vorheriger Plugin-Release: `v0.2.33`
Server-Release unveraendert live: `v0.2.6`

## Status in einem Satz

Der Android-Startup ist nach den `v0.2.31`..`v0.2.33`-Fixes schnell genug,
die Repo-/Docs-/Memory-Konsolidierung ist erledigt, und `v0.3.0` wurde als
sauberer Folgerelease abgeschlossen.

## Relevanter technischer Stand

Die entscheidenden Android-Erkenntnisse bleiben:

1. **Startup-Dirty-Tracking ist device-lokal, nicht vault-lokal.**
   Es darf nicht in einer gesyncten Vault-Datei liegen.

2. **Android-Kaltstart-Vault-Events (`modify/create/rename`) sind waehrend
   des ersten Startup-Fensters kein verlaessliches Dirty-Signal.**
   Waehle in dieser Phase nur echte `editor-change` Events als Signal.

3. **Der no-read Fast-Path funktioniert jetzt im Zielzustand.**
   Bester bestaetigter Trace:
   - `start.startup-state-loaded | cacheEntries=807 | localDirty=0`
   - `initial-sync.overlapping.plan | readsPlanned=0 | cleanSkipsPlanned=806`
   - `initial-sync.overlapping.done | skippedClean=806 | reads=0 | elapsedMs=3`
   - `initial-sync.complete | elapsedMs=612`

## Relevante Commits der Android-Linie

- `1c6a626` — erster no-read Startup-Fast-Path
- `33f9f34` — Dirty-Tracking device-lokal gemacht
- `1aa1153` — Android-Kaltstart-Vault-Events bis Ende des ersten `initialSync` ignoriert

## Was in dieser Session gelandet ist

### 1. Docs und Repo aufgeraeumt

Geloescht:
- `docs/next-session-prompt.md`
- `docs/next-session-review.md`

Neu/uebernommen:
- `AGENTS.md`
- `.claude/rules/memory-vault.md`
- `.agent-memory/` als projektweite langlebige Memory-Basis
- `gpt-audit/archive-2026-04-08-initial-sync-perf/`

Aktualisiert:
- `CLAUDE.md`
- `gpt-audit/previous-cycles.md`
- mehrere aeltere Audit-/Rule-Dokumente, damit die Repo-Invariants wieder gruen sind

Meta-Commit dieser Konsolidierung:
- `f21a7e2` — `docs: consolidate memory and audit docs`

### 2. Memory Vault gepflegt

Neu eingetragen:
- **Decision:** startup dirty tracking stays device-local
- **Mistake:** Android cold-start vault events poisoned dirty tracking
- **Procedure:** how to read Android startup performance traces

Danach:
- `memory-vault reindex`
- `memory-vault generate --sync-context-files`

### 3. 0.3.0 sauber validiert und released

Versionen synchronisiert auf:
- `package.json` -> `0.3.0`
- `manifest.json` -> `0.3.0`
- `versions.json` -> `0.3.0`
- `README.md` -> `0.3.x`

Validierung vor Release:
- `bunx tsc --noEmit`
- `bun run test`
- `bun run build`
- `verify_plugin --skipWasm`

Alles gruen.

Release-Schritt:
- Commit fuer den Versions-Bump erstellt
- `main` gepusht
- Tag `v0.3.0` gepusht
- GitHub Release fuer BRAT erstellt via Release-Workflow

## Aktiver Dokumentationszustand

Prominent und aktuell halten:
- `README.md`
- `CLAUDE.md`
- `AGENTS.md`
- `next-session-handoff.md`
- `docs/install-brat.md`
- `gpt-audit/previous-cycles.md`
- jeweilige `gpt-audit/archive-*/` Verzeichnisse nur als historische Details

## Naechste sinnvolle Schritte

1. Kurzer Android-Smoketest nach `v0.3.0`
   - 1 Kaltstart ohne Tippen
   - 1 Kaltstart mit sofortigem Tippen

2. Nur bei neuem echten Befund weiter in Startup-/Perf-Arbeit investieren.
   Kein blindes Nachoptimieren mehr.

3. Wenn ein neuer externer Audit startet:
   - Top-Level von `gpt-audit/` sauber halten
   - neuen Zyklus wieder in eigenes `archive-<datum>/` legen

## Was weiterhin nicht getan werden soll

- keinen Server anfassen
- kein mtime-Caching einfuehren
- kein neues Protokoll / keine neue Server-API anfangen
- `wasm/` nicht anfassen, solange `crates/` unveraendert bleiben
