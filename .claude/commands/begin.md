# Session starten

Initialisiere die Session fuer vaultcrdt-plugin.

## Vorgehen

1. **Memory-Session starten:** `mcp__memory__memory_session_start`
2. **Handoff lesen:** `next-session-handoff.md` (committed, nicht ephemer)
3. **Repo-Status:**
   ```bash
   git log --oneline -10
   git status
   ```
4. **CLAUDE.md** im Projektroot lesen falls noch nicht im Kontext
5. **Audit-Stand:** `gpt-audit/previous-cycles.md` querlesen — relevant fuer alle Architektur-Fragen

## Output

Kurze Zusammenfassung (5-8 Saetze):
- Was zuletzt erledigt wurde (letzte Session, Commits)
- Aktueller Repo-Stand (clean? offene Aenderungen?)
- Was als naechstes ansteht laut Handoff
- Offene Audit-Punkte falls relevant

Dann: "Sollen wir mit [naechster Schritt] weitermachen?"
