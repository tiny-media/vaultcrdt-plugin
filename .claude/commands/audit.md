# GPT-Audit-Zyklus

Neuen GPT-Audit-Zyklus starten oder einen laufenden weiterfuehren.

## Vorgehen

1. **Status pruefen:**
   ```bash
   ls gpt-audit/
   cat gpt-audit/previous-cycles.md
   ```
2. **Workflow konsultieren:** `gpt-audit/README.md` lesen — dort steht der verbindliche Zyklus-Workflow
3. **Aktuelles Verzeichnis bestimmen:**
   - Neuer Zyklus → `gpt-audit/archive-<YYYY-MM-DD>/` anlegen (heutiges Datum)
   - Laufender Zyklus → vorhandenes `archive-<datum>/` weiterverwenden
4. **Den User fragen** in welcher Phase wir sind:
   - Audit-Input vorbereiten (Code-Snapshot)
   - Audit-Output (`audit-<datum>.md`) eintragen
   - Decision-Matrix / Claude-Response
   - Implementation
   - Cycle close (Kurz-Summary in `previous-cycles.md`)

## Wichtig

- **Niemals** Audit-Findings in CLAUDE.md inline schreiben — sie gehoeren ins Cycle-Verzeichnis
- `previous-cycles.md` bekommt **nur** einen 1-Absatz-Eintrag pro geschlossenem Zyklus
- Vollstaendige Detail-Dateien bleiben in `archive-<datum>/`
- Aktuell offen / dauerhaft deferred: **#7 Multi-Editor-Konsistenz** und **#8 WS-Token-Logging** (Public-Release)
