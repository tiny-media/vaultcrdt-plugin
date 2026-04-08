---
name: audit-cycle
description: GPT-Audit-Zyklus starten oder weiterfuehren. Use when the user wants to open a new audit cycle, continue one, or close the current cycle.
---

# Audit Cycle

Externe GPT-Audits folgen einem festen Zyklus-Layout unter `gpt-audit/`.

## Layout

```
gpt-audit/
├── README.md                 ← verbindlicher Workflow
├── previous-cycles.md        ← rolling 1-Absatz-Summary pro geschlossenem Zyklus
└── archive-<YYYY-MM-DD>/     ← ein Verzeichnis pro Zyklus
```

## Schritte

1. `gpt-audit/README.md` lesen — das ist die Source of Truth fuer den Workflow
2. `gpt-audit/previous-cycles.md` lesen — zeigt was schon abgearbeitet wurde
3. Aktuellen Stand bestimmen:
   - Neuer Zyklus → `archive-<heute>/` anlegen
   - Laufender Zyklus → existierendes `archive-<datum>/` weiterverwenden
4. Dem User sagen in welcher Phase wir sind und was die naechste Aktion waere:
   - **Input vorbereiten**: Code-Snapshot + `previous-cycles.md` als Seed-Kontext (verhindert Rehashing)
   - **Audit eingepflegt**: `audit-<datum>.md` liegt vor, Proposals extrahieren
   - **Decision**: Accept/Reject/Defer pro Finding
   - **Implementation**: Claude-Response schreiben, Items abarbeiten
   - **Close**: 1-Absatz-Summary in `previous-cycles.md`, Verzeichnis bleibt liegen

## Wichtig

- Audit-Findings NIEMALS in `CLAUDE.md` inline dokumentieren — sie gehoeren ins Cycle-Verzeichnis
- `previous-cycles.md` bleibt kurz: max ~10 Zeilen pro Zyklus
- **Dauerhaft deferred** (public release):
  - #7 Multi-Editor-Konsistenz (UX-Polish)
  - #8 WS-Token-Logging (Ticket-Modell nice-to-have)
- Siehe `gpt-audit/archive-2026-04-06/claude-response.md` fuer Begruendungen
