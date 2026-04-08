---
description: Workflow und Layout fuer externe GPT-Audit-Zyklen
globs: gpt-audit/**
---

# GPT-Audit Workflow

## Layout

```
gpt-audit/
├── README.md                 ← verbindlicher Workflow fuer neue Zyklen
├── previous-cycles.md        ← rolling 1-Absatz-Summary pro geschlossenem Zyklus
└── archive-<YYYY-MM-DD>/     ← ein Verzeichnis pro Zyklus
    ├── audit-<datum>.md      ← Roh-Audit von GPT
    ├── proposals.md          ← strukturierte Vorschlaege
    ├── decision-matrix.md    ← Accept/Reject/Defer
    └── claude-response.md    ← finale Implementation + Rationale
```

## Regeln

- **Pro Zyklus genau ein `archive-<datum>/`** — Datum ist der Start des Zyklus, nicht der Abschluss
- **`previous-cycles.md`** bekommt nur eine kurze Summary (1 Absatz, max ~10 Zeilen) wenn der Zyklus geschlossen wird
- Detail bleibt im `archive-<datum>/` — niemals Inhalte in den Top-Level ziehen
- Audit-Findings gehoeren **nicht** in CLAUDE.md oder `next-session-handoff.md` — nur Status-Updates ("Audit-X laeuft", "6/8 done")

## Dauerhaft deferred (public release)

- **#7 Multi-Editor-Konsistenz** — UX-Polish
- **#8 WS-Token-Logging** — Ticket-Modell nice-to-have

Siehe `gpt-audit/archive-2026-04-06/claude-response.md` fuer die vollstaendige Begruendung.

## Neuen Zyklus eroeffnen

1. `README.md` lesen
2. `archive-<YYYY-MM-DD>/` anlegen (Datum heute)
3. Audit-Input vorbereiten: aktueller Code-Snapshot + `previous-cycles.md` als Seed-Kontext fuer den Audit-Prompt (verhindert Rehashing)
4. GPT-Output landet in `audit-<datum>.md`
5. Zyklus durchlaufen (Proposals → Decision → Claude-Response → Implementation)
6. Close: `previous-cycles.md` um 1-Absatz-Summary ergaenzen
