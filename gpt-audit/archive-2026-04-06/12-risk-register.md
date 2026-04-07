# Risk Register

Diese Datei sammelt die wichtigsten Risiken in einer etwas nüchterneren Form.

Skala:
- **Eintrittswahrscheinlichkeit**: niedrig / mittel / hoch
- **Auswirkung**: niedrig / mittel / hoch / sehr hoch
- **Priorität**: grobe Gesamtbewertung

---

## Risiko 1 — Initial-Sync übersieht lokale externe Änderungen

### Beschreibung
Eine Datei kann beim Initial-Sync übersprungen werden, obwohl sie lokal außerhalb des normalen Editor-Flows verändert wurde.

### Eintrittswahrscheinlichkeit
**mittel**

### Auswirkung
**hoch**

### Warum
Das ist kein rein theoretischer Fall:
- Git,
- Syncthing,
- externer Editor,
- Änderungen bei geschlossenem Obsidian

sind realistisch.

### Folge
- Änderung wird nicht hochgeladen
- Nutzer glaubt, alles sei synchron
- später entstehen Verwirrung oder Konflikte

### Empfohlene Gegenmaßnahme
VV-Skip nur bei zusätzlicher lokaler Inhaltsprüfung erlauben.

### Priorität
**sehr hoch**

---

## Risiko 2 — Gelöschte Dateien werden später wiederbelebt

### Beschreibung
Deletes sind nicht stark genug gegenüber stale/offline Clients abgesichert.

### Eintrittswahrscheinlichkeit
**mittel**

### Auswirkung
**hoch bis sehr hoch**

### Warum
Offline-Geräte und verspätete Reconnects sind im Alltag völlig normal.

### Folge
- Zombie-Dateien
- Frust und Misstrauen
- schwer erklärbare Dateiwiederkehr

### Empfohlene Gegenmaßnahme
Tombstone-Modell härten, State-Bereinigung verbessern, langfristig saubereres Recreate-Modell erwägen.

### Priorität
**sehr hoch**

---

## Risiko 3 — Falsche Dateitypen/Pfade geraten in den Sync

### Beschreibung
Nicht unterstützte Dateien oder problematische Pfade können in Sync-/Delete-Flows hineinrutschen.

### Eintrittswahrscheinlichkeit
**mittel**

### Auswirkung
**hoch**

### Folge
- unerwartete Deletes
- Schreiben an unerwünschte Pfade
- unsaubere Produktgrenzen

### Empfohlene Gegenmaßnahme
Klare Allowlist + Pfadvalidierung auf Client und Server.

### Priorität
**sehr hoch**

---

## Risiko 4 — WASM-Quelle und Artefakte driften auseinander

### Beschreibung
Rust-WASM-Quelle und die im Plugin ausgelieferten Artefakte sind nicht sauber synchron.

### Eintrittswahrscheinlichkeit
**hoch**

### Auswirkung
**mittel bis hoch**

### Folge
- schlechte Reproduzierbarkeit
- Wartungsprobleme
- Unklarheit, welcher Code wirklich läuft

### Empfohlene Gegenmaßnahme
Build-/Release-Kette explizit machen und CI absichern.

### Priorität
**hoch**

---

## Risiko 5 — Vault-Secrets liegen im Klartext in der DB

### Beschreibung
Bei einem DB-Leak sind Secrets sofort lesbar.

### Eintrittswahrscheinlichkeit
**niedrig bis mittel**

### Auswirkung
**hoch**

### Folge
- kompromittierte Vault-Zugänge
- unschöner öffentlicher Sicherheitszustand

### Empfohlene Gegenmaßnahme
Hashing mit Argon2id oder scrypt, plus sinnvolle Verify-/Migrationslogik.

### Priorität
**hoch**

---

## Risiko 6 — State-Key-Kollisionen bei lokalen `.loro`-Dateien

### Beschreibung
Unterschiedliche Dateipfade können denselben lokalen State-Key ergeben.

### Eintrittswahrscheinlichkeit
**niedrig**

### Auswirkung
**mittel bis hoch**

### Folge
- schwer erklärbare lokale Zustandsfehler
- vermischte oder überschriebene Persistenzzustände

### Empfohlene Gegenmaßnahme
Kollisionsfreies Encoding einführen.

### Priorität
**mittel**

---

## Risiko 7 — Mehrere offene Editoren derselben Datei werden inkonsistent

### Beschreibung
Ein Split-View kann unterschiedliche Stände derselben Datei anzeigen.

### Eintrittswahrscheinlichkeit
**mittel**

### Auswirkung
**mittel**

### Folge
- verwirrende UX
- geringeres Vertrauen in den Sync

### Empfohlene Gegenmaßnahme
Diffs oder Fallback-Updates auf alle offenen Leaves derselben Datei anwenden.

### Priorität
**mittel**

---

## Risiko 8 — JWT im WS-Query-String landet in Logs

### Beschreibung
WebSocket-Token können über Query-Logging sichtbar werden.

### Eintrittswahrscheinlichkeit
**mittel**

### Auswirkung
**mittel**

### Folge
- unnötige Exposition von Tokens
- härterer Security-Eindruck bei öffentlicher Nutzung

### Empfohlene Gegenmaßnahme
Dokumentation, kurze Token-Lebensdauer, später ggf. WS-Tickets.

### Priorität
**mittel**

---

## Risiko 9 — Build-Warnungen und Kommentardrift reduzieren Vertrauen

### Beschreibung
Auch wenn alles läuft, wirken Warnungen und Inkonsistenzen unreif.

### Eintrittswahrscheinlichkeit
**hoch**

### Auswirkung
**niedrig bis mittel**

### Folge
- geringere Release-Reife
- mehr Rückfragen bei öffentlichem Teilen

### Empfohlene Gegenmaßnahme
Warnungen beseitigen, Kommentare an Verhalten angleichen.

### Priorität
**niedrig bis mittel**

---

## Zusammenfassung nach Priorität

## Sehr hohe Priorität
- Initial-Sync-Konsistenz
- Delete-/Tombstone-Härtung
- Pfad-/Dateityp-Policy

## Hohe Priorität
- WASM-Quelle/Artefakt-Sync
- Auth-/Secret-Härtung

## Mittlere Priorität
- State-Key-Encoding
- Multi-Editor-Konsistenz
- WS-Token-/Logging-Härtung

## Niedrigere Priorität
- Build-Warnungen / Kommentardrift

---

## Mein ehrliches Fazit

Wenn ich das Projekt wie ein kleines Produkt und nicht nur wie ein Code-Experiment bewerte, dann sind die größten Risiken klar:

1. **stille Korrektheitsprobleme**
2. **Delete-/Wiederbelebungsprobleme**
3. **zu offene Sync-Grenzen**

Alles andere ist auch wichtig — aber diese drei Gruppen bestimmen am stärksten, ob Nutzer dem System vertrauen können.
