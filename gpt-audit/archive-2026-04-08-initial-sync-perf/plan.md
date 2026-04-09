# Plan — Android Initial-Sync: Rest-Latenz + aktiver Editor waehrend Startup

Datum: 2026-04-09
Status: offen, nach echter Android-Diagnose aktualisiert
Cycle-Typ: out-of-band Performance-/UX-Audit

## Kurzfassung

Es gibt zwei getrennte Android-Probleme:

1. **Rest-Latenz von ca. 8s beim Restart**
   - fast sicher verursacht durch den seriellen VV+Hash-Check ueber ~800 Files
   - also `vault.read()` + `fnv1aHash()` pro Datei

2. **Text verschwindet, wenn waehrend des Startfensters in die aktive Datei
   getippt wird**
   - nicht mehr Broadcast-Queue
   - nicht mehr Conflict-Fork
   - nicht mehr aktiver Editor-Rewrite
   - aktuell wahrscheinlich: **Disk-Persist des aktiven Files waehrend des
     Mobile-Startup-Fensters triggert einen Obsidian-Mobile-Reload/Rebind**

Diese zwei Themen muessen ab jetzt getrennt behandelt werden.

---

## Tatsachengrundlage aus den echten Android-Traces

### Befund A — Rest-Latenz ist der Overlapping VV+Hash-Scan

Mehrere Traces zeigen am Ende dieselbe Struktur:

- `overlapping` ca. 804..808 Dateien
- `skippedVVMatch` ca. 803..807 Dateien
- `elapsedMs` fuer `initial-sync.overlapping.done` ca. 5.5s bis 8s

Beispiel:

```text
initial-sync.partition        overlapping=807
initial-sync.overlapping.done skippedVVMatch=806 elapsedMs=7928
```

Schluss:
- das ist nicht Server-Latenz
- nicht CRDT-Merge-CPU
- sondern fast nur Android-Datei-I/O + Hashing

### Befund B — Typing-Bug sitzt im aktiven Startup-File

Der relevante Pfad fuer `test.md` wurde Schritt fuer Schritt eingegrenzt:

#### Vor den spaeteren Fixes
- `concurrent external edit conflict`
- danach `writeToVault(serverText)`
- klarer Overwrite des User-Texts

#### Nach `v0.2.25`
- Conflict-Fork weg
- Pfad wurde zu `concurrent-live-editor-merge`

#### Nach `v0.2.27`
- kein aktiver Editor-Rewrite mehr
- Trace zeigte `overlap.active-noop`
- trotzdem verschwand der Text noch
- in einem Fall blieb sogar etwas Text weg

#### Nach `v0.2.28`
- statt No-Op nun `overlap.active-persist-disk`
- also: Editor bleibt in Ruhe, aber der gemergte Text wird noch auf Disk
  persistiert
- trotzdem verschwindet der Text weiter spaeter

Beispiel aus der letzten Trace:

```text
+13140ms | overlap.concurrent-live-editor-merge | path=test.md | data={"serverLen":153,"localLen":197}
+13140ms | overlap.editor-mode | path=test.md | data={"isActiveEditorDoc":true}
+13160ms | overlap.active-persist-disk | path=test.md | data={"textLen":197}
...
+21350ms | initial-sync.end
```

Wichtig:
- fuer `test.md` kam **danach kein weiterer Plugin-Schreibpfad** mehr in der
  Trace
- kein queued Broadcast
- kein spaeteres `broadcast.write-to-vault`
- kein Conflict-Fork

Schluss:
- der verbleibende sichtbare Effekt wird sehr wahrscheinlich durch den
  **Disk-Persist des aktiven Files waehrend Obsidian-Mobile-Startup**
  getriggert
- also eher Host-Reaktion auf unseren Disk-Write als direkter spaeterer
  Plugin-Editor-Overwrite

### Befund C — Kontrolltest ohne Plugin

User-Test:
- ohne Plugin laedt `test.md` auf Android sofort
- mit Plugin tritt das ganze Startup-Fenster und das Verschwindeverhalten auf

Schluss:
- das Problem braucht die Plugin-Praesenz
- aber die neueren Traces sprechen dafuer, dass der verbleibende Effekt nicht
  mehr in einem spaeten Plugin-Editor-Schreibpfad sitzt, sondern in der
  Wechselwirkung Plugin-Disk-Write <-> Obsidian-Mobile-Startup

---

## Release-Verlauf dieser Untersuchung

- `v0.2.19` — finalen Hash richtig persistiert, ~16s -> ~8s
- `v0.2.20` — open-editor Schutz im initialSync, nicht ausreichend
- `v0.2.21` — Broadcast-/Concurrent-Typing-Schutz, nicht ausreichend
- `v0.2.22` — deferred local edits waehrend initialSync, nicht ausreichend
- `v0.2.23` — sauberer Revert auf `v0.2.19`-Basis
- `v0.2.24` — Startup-Trace-Export eingebaut
- `v0.2.25` — Startup-Editor-Edits nicht mehr in Conflict-Fork schicken
- `v0.2.26` — redundante `writeToVault()`-Editor-Rewrites vermeiden
- `v0.2.27` — Active-Editor-Rewrite schon im `syncOverlappingDoc()` vermeiden
- `v0.2.28` — Active-Editor-Fall statt No-Op nur noch auf Disk persistieren

Stand nach `v0.2.28`:
- Performance noch unveraendert bei ~8s
- Tippen waehrend Startup auf Android weiterhin nicht sicher
- Diagnose aber jetzt deutlich sauberer als am Anfang

---

## Naechster enger Fix

### Ziel

Den letzten plausiblen Plugin-Trigger entfernen:
**kein Disk-Persist fuer das aktive Startup-edited File waehrend initialSync**.

### Warum genau dieser Schritt

Aktuell ist der letzte dokumentierte Plugin-Eingriff auf `test.md`:

```text
overlap.active-persist-disk
```

Wenn danach der Text verschwindet, ist der sauberste naechste Test:
- genau diesen einen Schritt fuer den aktiven Startup-Fall wegnehmen
- nichts anderes veraendern

### Geplanter Guard

Nur fuer diesen sehr engen Fall:
- `editedDuringStartup === true`
- `isActiveEditorDoc === true`
- aktueller Editorinhalt matcht bereits den gemergten CRDT-Text

Dann:
- **kein** `editor.writeToVault()`
- **kein** `vault.modify()`
- **kein** Disk-Persist der `.md`-Datei in `initialSync`
- CRDT-Snapshot darf weiter persistiert werden
- Disk-Persist dem normalen Obsidian-Autosave / spaeteren regulieren Save
  ueberlassen

### Erwarteter Effekt

Wenn die Hypothese stimmt:
- Text bleibt sichtbar
- kein spaeteres Verschwinden/Wiederauftauchen
- Rest-Latenz (~8s) bleibt vorerst gleich

---

## Regression-Tests fuer die naechste Session

### 1. Active startup editor: no conflict

Schon vorhanden/nahe dran:
- Startup-Editor-Edit darf nicht mehr in den Conflict-Fork laufen

### 2. Active startup editor: no disk persist during initialSync

Neu/zu verschaerfen:
- Setup wie Android-Fall
- aktiver Editor ist bereits auf gemergtem Text
- erwartet:
  - kein Conflict-File
  - kein Editor-Rewrite
  - **kein Disk-Modify im `initialSync`-Pfad fuer die aktive Datei**

### 3. Normale nicht-aktive oder nicht-startup-editierte Faelle unveraendert

Wichtig, damit der Guard nicht zu breit wird.

---

## Was die naechste Session nicht tun sollte

- nicht erneut mehrere halbblinde BRAT-Releases hintereinander shippen
- nicht Server/API aendern
- nicht das Performance-Ticket mit dem Typing-Ticket vermischen
- nicht Android-mtime als Shortcut einfuehren

---

## Separates Performance-Ticket fuer spaeter

Die ~8s bleiben ein eigenes Thema.

Aktuelle realistische Optionen dafuer:
1. VV-Cache um ein zusaetzliches, Android-taugliches cheap skip-Signal
   erweitern, ohne mtime zu vertrauen
2. `app.metadataCache`/Obsidian-eigene Daten pruefen, ob schon ein nutzbarer
   Hash/Dirty-Hinweis existiert
3. wenn das nicht reicht: Architektur-Tradeoff bewusst entscheiden
   (voll sichere Hash-Reads vs. schnellerer Mobile-Start)

Aber erst nach Korrektheits-Fix.
