# Minimal sinnvoller Stand für privaten Einsatz

Diese Datei beantwortet die Frage:

> Was wäre aus meiner Sicht der **kleinste vertretbare Zustand**, damit du das Plugin und den Server mit gutem Gefühl für dich, Freunde und Familie nutzen kannst — **ohne** schon alles für einen öffentlichen Release perfekt gemacht zu haben?


## Kurzantwort

Wenn du einen **privat brauchbaren, relativ ruhigen Stand** willst, würde ich mindestens diese vier Punkte erledigt sehen:

1. **Initial-Sync-Konsistenz fixen**
2. **klare Pfad-/Dateityp-Policy einziehen**
3. **Delete-/Tombstone-Verhalten spürbar härten**
4. **lokale State-Key-Kollisionen ausschließen**

Alles andere ist ebenfalls sinnvoll — aber diese vier Punkte sind für mich der Kern von:
- keine stillen Überraschungen,
- weniger Datenchaos,
- weniger „warum ist die Datei wieder da / weg / komisch?“.

---

## Mein empfohlener Minimalumfang

## 1. Initial-Sync-Konsistenz

### Warum das privat schon wichtig ist
Gerade in kleinen Setups passieren externe Änderungen oft ganz normal:
- man bearbeitet eine Datei schnell im Terminal,
- Syncthing oder Git spielt etwas ein,
- Obsidian war gerade zu.

Wenn der Initial-Sync diese Änderungen still übergeht, leidet das Vertrauen in das ganze System.

### Mein Minimalziel
- VV-gleich allein reicht nicht für Skip
- lokaler Dateiinhalt muss mitgeprüft werden

### Warum ich das als Pflicht sehe
Weil hier ein echter stiller Fehler möglich ist, nicht nur eine unschöne Kante.

---

## 2. Pfad-/Dateityp-Policy

### Warum das privat schon wichtig ist
Selbst im Familienkreis kann es sonst zu komischen Effekten kommen:
- Nicht-Markdown-Dateien werden mitgedacht, obwohl sie es eigentlich nicht sollten
- Deletes/Tombstones treffen Dateien, die gar nicht im Sync sein sollten
- Pfade unter `.obsidian/` oder andere Sonderpfade sind unnötig riskant

### Mein Minimalziel
- nur `.md`
- `.obsidian/` blockieren
- keine traversal-/komischen Pfade

### Warum ich das als Pflicht sehe
Weil es die Betriebsfläche klein hält und die meisten späteren Sonderfälle schon früh eliminiert.

---

## 3. Delete-/Tombstone-Härtung

### Warum das privat schon wichtig ist
In echten Haushalts-/Freundeskreis-Setups sind Geräte oft unregelmäßig online.

Das heißt:
- jemand löscht auf Gerät A,
- Gerät B ist tagelang oder wochenlang weg,
- später reconnectet B.

Genau da entstehen sonst Zombie-Dateien und Frust.

### Mein Minimalziel
Noch nicht das perfekte generationsbasierte Modell, aber mindestens:
- Tombstones deutlich länger behalten
- lokale alte CRDT-Zustände beim Delete sauber entfernen
- stale Resurrection erschweren/verhindern

### Warum ich das als Pflicht sehe
Weil Delete-Fehler im Alltag besonders unerquicklich sind.

---

## 4. State-Key-Encoding robust machen

### Warum das privat schon sinnvoll ist
Das Problem ist selten, aber wenn es auftritt, ist es schwer zu verstehen.

Dann sieht es schnell so aus, als wäre „der Sync komisch“, obwohl eigentlich nur zwei verschiedene Dateien lokal denselben State-Key teilen.

### Mein Minimalziel
- kollisionsfreies Encoding für `.loro`-Dateinamen
- einfache Migration oder Fallback-Lesen alter Keys

### Warum ich das in den Minimalstand aufnehme
Weil es ein kleiner Fix mit gutem Nutzen ist.

---

## Was ich für privat noch **nicht zwingend** als Mindestblocker sehe

Diese Punkte sind wichtig, aber für den rein privaten Einsatz nicht unbedingt die erste Schwelle:

### WASM-Quelle / Artefakte sauberziehen
Wichtig für Wartbarkeit und Rebuilds, aber privat nicht die erste Frage des Vertrauens in den täglichen Sync.

### Auth-/Secret-Härtung
Sehr wichtig vor öffentlichem Teilen. Für rein privaten Betrieb kann man das noch etwas später angehen, wenn der Server gut abgeschirmt läuft.

### Multi-Editor-Konsistenz
Eine gute UX-Verbesserung, aber kein Kernblocker.

### WS-Token-/Logging-Härtung
Wichtig, aber eher Security-/Deployment-Härtung als Alltags-Sync-Korrektheit.

---

## Mein privater „gut genug“-Standard

Wenn du mich fragst, wann ich sagen würde:

> „Okay, jetzt würde ich das mit besserem Gefühl für mich und ein paar vertraute Leute laufen lassen“

Dann wäre meine Antwort:

### Muss erledigt sein
- Initial-Sync-Konsistenz
- Pfad-/Dateityp-Policy
- Delete-/Tombstone-Härtung

### Sollte sehr sinnvollerweise zusätzlich erledigt sein
- State-Key-Encoding

---

## Was ich zusätzlich organisatorisch empfehlen würde

Auch bei einem guten privaten Stand würde ich weiter empfehlen:

1. **regelmäßige Vault-Backups**
2. **Server-DB-Backups**
3. **zunächst kleiner Nutzerkreis**
4. **bewusstes Beobachten von Delete-/Rename-Fällen**
5. **keine voreilige Freigabe an viele Leute gleichzeitig**

### Warum ich das dazu sage
Weil Sync-Systeme nie nur aus Code bestehen. Der ruhigste Start entsteht fast immer aus:
- guter Code,
- kleinen Nutzerzahlen,
- und sauberen Backups.

---

## Mein ehrliches Fazit

Wenn du auf einen **minimal vernünftigen privaten Release-Stand** zielen willst, dann würde ich mich auf diese Frage fokussieren:

> Kann das System im normalen Alltag Änderungen erkennen, nur die richtigen Dateien anfassen und Deletes nicht komisch behandeln?

Darum sind aus meiner Sicht diese Punkte der Kern:
- Initial-Sync
- Pfad-/Dateipolicy
- Delete-/Tombstones
- State-Key-Encoding

Wenn die sitzen, hast du schon einen deutlich ruhigeren und vertrauenswürdigeren privaten Stand.
