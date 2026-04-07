# Änderungsfahrplan nach dem Audit

Diese Datei enthält **keine Code-Änderungen**, sondern nur einen Vorschlag für die sinnvolle Reihenfolge.

## Ziel

Du willst das Projekt so weit bringen, dass es:
- für dich selbst zuverlässig bleibt,
- für Freunde/Familie stressfrei nutzbar ist,
- und später mit gutem Gewissen öffentlich teilbar wird.

Dafür würde ich die Themen nicht bunt gemischt anfassen, sondern in dieser Reihenfolge:

## Empfohlene Reihenfolge

| Priorität | Thema | Warum zuerst? | Aufwand | Wichtig für Public Release |
|---|---|---|---|---|
| 1 | `01-proposal-initial-sync-consistency.md` | Das ist ein echter Korrektheitsfehler: Änderungen können übersehen werden | klein bis mittel | ja |
| 2 | `02-proposal-path-and-file-policy.md` | Verhindert unangenehme Seiteneffekte bei falschen Dateitypen/Pfaden | klein bis mittel | ja |
| 3 | `03-proposal-delete-tombstone-model.md` | Delete-Semantik ist für echte Langzeitnutzung entscheidend | mittel bis größer | ja |
| 4 | `04-proposal-wasm-source-artifact-sync.md` | Ohne saubere WASM-Kette ist das Projekt schwer wartbar und schlecht reproduzierbar | mittel | ja |
| 5 | `05-proposal-auth-and-secret-hardening.md` | Für Community-/GitHub-Release wichtig, privat aber teils noch tolerierbar | mittel | ja |
| 6 | `06-proposal-state-key-encoding.md` | Eher selten, aber ein echter Daten-/State-Kollisionsbug | klein | sehr sinnvoll |
| 7 | `07-proposal-multi-editor-consistency.md` | UX-/Konsistenzthema bei Split-Views | klein | sinnvoll |
| 8 | `08-proposal-websocket-token-and-logging.md` | Eher Härtung/Deployment als Kernkorrektheit | mittel | sinnvoll |

## Ehrliche Einschätzung

### Was ich relativ schnell und mit wenig Risiko machen würde
- Initial-Sync-Konsistenz
- Pfad-/Markdown-Policy
- State-Key-Encoding
- Multi-Editor-Konsistenz

Das sind gute Kandidaten für baldige, überschaubare Verbesserungen.

### Was ich bewusster designen würde
- Delete-/Tombstone-Modell
- Auth-/Secret-Härtung
- WebSocket-Token-Modell
- WASM-Source/Artefakt-Prozess

Diese Themen lohnen sich sehr, aber dort würde ich nicht „einfach schnell patchen“, sondern bewusst eine Variante auswählen.

## Meine persönliche Empfehlung

Wenn du mich nach dem besten Verhältnis aus **Nutzen / Risiko / Aufwand** fragst:

### Phase A — jetzt bald
1. Initial-Sync fixen
2. Pfad-/Dateityp-Policy einziehen
3. State-Key-Encoding robust machen
4. Multi-Editor-Diff sauber machen

### Phase B — vor Public Release
5. Delete-/Tombstone-Modell härten
6. WASM-Prozess sauberziehen
7. Secrets hashen / Auth härten
8. WS-Token-/Logging-Härtung

## Warum ich das so staffeln würde

Weil Phase A vor allem die **funktionale Zuverlässigkeit** verbessert, ohne die Architektur radikal umzubauen.

Phase B verbessert eher die **Langzeitstabilität, Wartbarkeit und Release-Sicherheit**. Das ist genauso wichtig, aber dort gibt es mehr echte Designentscheidungen.

## Nächste Dateien

- `01-proposal-initial-sync-consistency.md`
- `02-proposal-path-and-file-policy.md`
- `03-proposal-delete-tombstone-model.md`
- `04-proposal-wasm-source-artifact-sync.md`
- `05-proposal-auth-and-secret-hardening.md`
- `06-proposal-state-key-encoding.md`
- `07-proposal-multi-editor-consistency.md`
- `08-proposal-websocket-token-and-logging.md`
