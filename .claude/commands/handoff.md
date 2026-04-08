# Session Handoff

Aktualisiere `next-session-handoff.md` (committed, lebt im Repo-Root).

## Vorgehen

1. **Repo-Status erfassen:**
   ```bash
   git log --oneline -10
   git status
   git diff --stat
   ```

2. **`next-session-handoff.md` neu schreiben** mit folgenden Abschnitten:

   ### Was diese Session erreicht hat
   Konkrete Aenderungen mit Commit-Hashes. Bei mehreren Themen: Subheadings.

   ### Aktueller Stand
   Repo sauber? Was existiert wo? Uncommittete Aenderungen?

   ### Naechste Session
   Konkreter erster Schritt. Welche Dateien zuerst lesen?

   ### Offene Punkte (priorisiert)
   A (kritisch) / B (wichtig) / C (nice-to-have).

   ### Gotchas / Runtime-Observations
   Stolpersteine, beobachtete Edge-Cases, Workarounds.

   ### Wichtige Kontextinfos
   Permanente Invariants nochmal kurz (test-Befehl, mtime, version-pin) — der naechste Sessionsstart liest das.

3. **Bestaetigung:** Datei dem User zeigen, fragen ob etwas fehlt.

## Wichtig

- **Diese Datei wird committed** — anders als webstack/.claude/handoff.md ist sie kein ephemerer Scratchpad
- Nur Fakten, keine Vermutungen
- Commit-Hashes muessen stimmen
- Lesbar in 2 Minuten
- Keine Zeitschaetzungen ("morgen", "naechste Woche")
- Datum als absolute ISO-Date (2026-04-07), nie relativ
