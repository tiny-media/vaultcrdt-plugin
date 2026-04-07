# Entscheidungs-Matrix: Was ist wann sinnvoll?

Diese Datei ist die **kompakte Management-/Priorisierungsansicht** zu den ausführlicheren Vorschlagsdateien.

Ziel:
- schnell sehen, **was du privat bald machen solltest**,
- was **vor GitHub** sinnvoll ist,
- und was ich **vor einem Community-Release** wirklich empfehlen würde.

---

## Legende

- **Pflicht jetzt** = ich würde es zeitnah machen, bevor du dem System richtig vertraust
- **Vor GitHub** = sollte vor öffentlichem Teilen sinnvollerweise erledigt sein
- **Vor Community-Release** = ich würde es vor Obsidian Community Listing sehr klar empfehlen
- **Später** = wichtig, aber nicht zuerst

---

## Kompakte Matrix

| Thema | Privat bald | Vor GitHub | Vor Community | Aufwand | Mein ehrlicher Eindruck |
|---|---:|---:|---:|---:|---|
| Initial-Sync-Konsistenz | **Ja** | **Ja** | **Ja** | klein–mittel | Echter Korrektheitsfehler, beste erste Verbesserung |
| Pfad-/Dateityp-Policy | **Ja** | **Ja** | **Ja** | klein–mittel | Sehr sinnvoll, weil sie viele spätere Probleme verhindert |
| Delete-/Tombstone-Modell | **Ja** | **Ja** | **Ja** | mittel–größer | Einer der wichtigsten Langzeitpunkte; nicht nur kosmetisch |
| WASM-Quelle ↔ Artefakte synchron | optional bald | **Ja** | **Ja** | mittel | Kein User-Feature, aber extrem wichtig für Wartbarkeit und Vertrauen |
| Auth-/Secret-Härtung | optional bald | **Ja** | **Ja** | mittel | Für privaten Betrieb noch verschiebbar, öffentlich aber klar wichtig |
| State-Key-Encoding robust | **Ja** | sinnvoll | sinnvoll | klein | Seltener Bug, aber echter Daten-/State-Risikofall |
| Multi-Editor-Konsistenz | sinnvoll | sinnvoll | sinnvoll | klein | Gute Qualitätsverbesserung, aber kein Top-Blocker |
| WS-Token-/Logging-Härtung | später | sinnvoll | sinnvoll–wichtig | mittel | Eher Härtung/Deployment als Kernkorrektheit |

---

## Meine echte Priorisierung in Klartext

## Stufe 1 — das würde ich am ehesten als Nächstes angehen

### 1. Initial-Sync-Konsistenz
**Warum:**
Das ist die klarste Stelle, wo still Änderungen übersehen werden können.

**Wenn ich nur eine Sache fixen dürfte, wäre das mein erster Kandidat.**

Passende Detaildatei:
- `01-proposal-initial-sync-consistency.md`

---

### 2. Pfad-/Dateityp-Policy
**Warum:**
Das reduziert sofort die Gefahr von unerwartetem Verhalten und macht das Projekt nach außen viel sauberer.

**Gerade für andere Nutzer ist eine harte Grenze besser als implizites „es wird schon meistens Markdown sein“.**

Passende Detaildatei:
- `02-proposal-path-and-file-policy.md`

---

### 3. Delete-/Tombstone-Modell
**Warum:**
Wenn ein Sync-System bei Deletes nicht wirklich robust ist, kommt der Ärger oft erst später — dann aber richtig nervig.

**Das Thema ist etwas größer, aber fachlich sehr wichtig.**

Passende Detaildatei:
- `03-proposal-delete-tombstone-model.md`

---

## Stufe 2 — vor öffentlichem Teilen sehr sinnvoll

### 4. WASM-Quelle/Artefakte sauberziehen
**Warum:**
Wenn du es teilen willst, musst du Builds und Releases reproduzierbar nachvollziehen können.

**Das ist kein Endnutzer-Feature, aber es trennt „läuft auf meinem Rechner“ von „sauber wartbares Projekt“.**

Passende Detaildatei:
- `04-proposal-wasm-source-artifact-sync.md`

---

### 5. Auth-/Secret-Härtung
**Warum:**
Für privates Self-Hosting kann man das eine Weile vor sich herschieben.
Für GitHub/Public ist es aus meiner Sicht aber nicht mehr nur optional.

**Ich würde ungern ein öffentlich empfohlenes Sync-Tool mit Klartext-Secrets in der DB stehen lassen.**

Passende Detaildatei:
- `05-proposal-auth-and-secret-hardening.md`

---

## Stufe 3 — gute Qualitätsverbesserungen

### 6. State-Key-Encoding
**Warum:**
Selten, aber echter Bug.

**Guter Kandidat für einen kleinen, sauberen Qualitätsfix.**

Passende Detaildatei:
- `06-proposal-state-key-encoding.md`

---

### 7. Multi-Editor-Konsistenz
**Warum:**
Merkbar für Nutzer mit Split-Views, aber nicht so kritisch wie Korrektheit/Deletes.

**Ich sehe das als gute Reifegrad-Verbesserung.**

Passende Detaildatei:
- `07-proposal-multi-editor-consistency.md`

---

### 8. WS-Token-/Logging-Härtung
**Warum:**
Wichtig, aber eher Betriebs-/Security-Härtung als Kern-Sync-Logik.

**Würde ich hinter Datenkonsistenz und Delete-Semantik einordnen.**

Passende Detaildatei:
- `08-proposal-websocket-token-and-logging.md`

---

## Wenn du nur nach „privat jetzt gut genug?“ fragst

Dann wäre meine ehrliche Mindestliste:

### Mindestens bald machen
- Initial-Sync-Konsistenz
- Pfad-/Dateityp-Policy
- Delete-/Tombstone-Härtung in einer guten Zwischenstufe

### Sehr sinnvoll zusätzlich
- State-Key-Encoding

### Kann noch warten
- Auth-/Secret-Härtung
- WASM-Prozess
- WS-Token-Härtung

**Ehrlich gesagt:** Für nur dich/Familie kann man Security-Themen noch etwas schieben, aber bei Konsistenz/Deletes wäre ich vorsichtiger.

---

## Wenn du nach „vor GitHub öffentlich teilen?“ fragst

Dann würde ich mindestens sehen wollen:
- Initial-Sync-Konsistenz
- Pfad-/Dateityp-Policy
- Delete-/Tombstone-Härtung
- WASM-Prozess sauber
- Secrets nicht mehr im Klartext

**Das wäre für mich die Schwelle von „privat brauchbar“ zu „öffentlich vertretbar“.**

---

## Wenn du nach „vor Obsidian Community?“ fragst

Dann würde ich es am liebsten so sehen:
- alle fünf Punkte oben erledigt
- State-Key-Encoding robust
- Multi-Editor-Konsistenz verbessert
- WS-Token-/Logging-Risiken dokumentiert oder reduziert
- Build warnungsfrei
- Release-/Rebuild-Prozess klar dokumentiert

**Nicht weil alles davon gleich kritisch ist, sondern weil sich bei Community-Plugins kleine schiefe Kanten schnell summieren.**

---

## Meine ehrlichste Gesamtbewertung

### Was ich wirklich als Blocker empfinde
- Initial-Sync-Konsistenz
- Delete-/Tombstone-Thema
- Pfad-/Dateityp-Grenzen

### Was ich als starken Release-Qualitätsfaktor sehe
- WASM-Reproduzierbarkeit
- Auth-/Secret-Härtung

### Was ich als sehr gute Reifegrad-Verbesserung sehe
- State-Key-Encoding
- Multi-Editor-Konsistenz
- WS-Token-/Logging-Härtung

---

## Meine praktische Empfehlung an dich

Wenn du mich nach der vernünftigsten Arbeitsreihenfolge fragst:

1. **Initial-Sync-Konsistenz**
2. **Pfad-/Dateityp-Policy**
3. **Delete-/Tombstone-Modell**
4. **State-Key-Encoding**
5. **WASM-Quelle/Artefakte**
6. **Auth-/Secret-Härtung**
7. **Multi-Editor-Konsistenz**
8. **WS-Token-/Logging-Härtung**

### Warum ich State-Key-Encoding vor WASM/Auth ziehe
Weil es ein kleiner, klarer technischer Bugfix ist, den man gut zwischendurch stabilisieren kann.

### Warum WASM/Auth danach kommen
Weil sie sehr wichtig sind, aber eher den Charakter von **Release- und Wartungsqualität** haben als unmittelbare Sync-Korrektheit.

---

## Passende Detaildokumente

- `00-change-roadmap.md`
- `01-proposal-initial-sync-consistency.md`
- `02-proposal-path-and-file-policy.md`
- `03-proposal-delete-tombstone-model.md`
- `04-proposal-wasm-source-artifact-sync.md`
- `05-proposal-auth-and-secret-hardening.md`
- `06-proposal-state-key-encoding.md`
- `07-proposal-multi-editor-consistency.md`
- `08-proposal-websocket-token-and-logging.md`

---

## Kurzfazit in einem Satz

**Für Vertrauen in den Sync zuerst Korrektheit und Deletes, für öffentliches Teilen danach Build-/WASM-/Security-Reife.**
