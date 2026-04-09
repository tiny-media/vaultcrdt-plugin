# Android-Startup-Trace-Funde

Datum: 2026-04-09
Status: Arbeitsnotiz fuer die naechste Session

## Repro, der wirklich zaehlt

- Android, Vault `richardsachen`
- Plugin aktiv
- `test.md` ist die aktive Datei
- waehrend des Startfensters direkt tippen

Beobachtung:
- Text verschwindet spaeter
- taucht teils wieder auf
- in einem Fall blieb ein Teil des fruehen Texts sogar weg

## Kontrolltest

Ohne Plugin:
- `test.md` oeffnet auf Android sofort
- kein vergleichbares langsames Startup-Fenster auf dieser Datei

Schluss:
- Plugin-Praesenz ist notwendig, aber der Fehler muss nicht zwingend ein
  spaeter direkter Plugin-Editor-Overwrite sein

## Wichtigste Spuren aus den Traces

### 1. Vor `v0.2.25`

Der User-Text lief in:
- `overlap.concurrent-conflict`
- dann `overlap.concurrent-write-to-vault`

Das war ein echter Plugin-Overwrite.

### 2. Nach `v0.2.25`

Der Conflict-Fork war weg:
- `overlap.concurrent-live-editor-merge`

### 3. Nach `v0.2.27`

Der aktive Rewrite war weg:
- `overlap.active-noop`

Trotzdem verschwand der Text weiter.

### 4. Nach `v0.2.28`

Der letzte dokumentierte Plugin-Eingriff fuer `test.md` ist:

```text
overlap.active-persist-disk
```

Danach gibt es in der Trace fuer `test.md`:
- keinen queued Broadcast
- kein `broadcast.write-to-vault`
- keinen Conflict-Fork
- keinen spaeteren Active-Editor-Rewrite mehr

Das macht `active-persist-disk` zum aktuell besten Kandidaten.

## Zwei konkrete Trace-Beispiele

### Beispiel A — `vorher` getippt, spaeter nicht sauber wieder da

Wichtige Linien:

```text
+7594ms | initial-sync.priority.begin | path=test.md
+7595ms | overlap.begin | path=test.md | data={"localLen":248}
+7596ms | overlap.doc-state | path=test.md | data={"hadPersistedState":true,"version":1904,"editedDuringStartup":true}
+7630ms | ws.sync-delta | path=test.md | data={"deltaLen":22}
+7630ms | overlap.editor-mode | path=test.md | data={"isActiveEditorDoc":true}
+7632ms | overlap.active-persist-disk | path=test.md | data={"textLen":248}
+13758ms | initial-sync.end
```

Interpretation:
- Plugin merge-t den aktiven Text korrekt
- Plugin persistiert den aktiven Text auf Disk
- spaeter verschwindet Text trotzdem, ohne dass die Trace fuer `test.md`
  noch einen weiteren Plugin-Schreibpfad zeigt

### Beispiel B — letzte `v0.2.28`-Trace

Wichtige Linien:

```text
+13079ms | overlap.begin | path=test.md | data={"localLen":197}
+13080ms | overlap.doc-state | path=test.md | data={"hadPersistedState":true,"version":1809,"editedDuringStartup":true}
+13140ms | overlap.concurrent-live-editor-merge | path=test.md | data={"serverLen":153,"localLen":197}
+13140ms | overlap.editor-mode | path=test.md | data={"isActiveEditorDoc":true}
+13160ms | overlap.active-persist-disk | path=test.md | data={"textLen":197}
+21350ms | initial-sync.end
```

Interpretation:
- Kein Conflict-Fork mehr
- Kein Rewrite des sichtbaren Editors mehr
- verbleibender Kandidat bleibt der Disk-Persist

## Performance-Spur

Mehrere Traces bestaetigen:

```text
initial-sync.partition        overlapping ~= 804..808
initial-sync.overlapping.done skippedVVMatch ~= 803..807
elapsedMs                     ~= 5.5s..8s
```

Das ist sehr wahrscheinlich:
- `readEffectiveLocalContent()`
- `app.vault.read(file)`
- `fnv1aHash()`

pro Datei, seriell.

## Wichtiger Caveat zur Trace

`push.delta.sent` darf nicht als sicherer Netzwerk-Event gelesen werden.
Der Logger sitzt vor dem stillen `send()`-No-Op-Guard. Wenn der WS noch
nicht offen ist, kann die Zeile da sein, obwohl nichts ans Netz ging.

## Naechste Hypothese fuer die Implementation

Der engste, sauberste naechste Test ist:
- fuer `editedDuringStartup && isActiveEditorDoc && editorAlreadyMatches`
- **kein Disk-Persist der aktiven `.md`-Datei waehrend initialSync**
- CRDT-Snapshot weiter persistieren
- Disk dem normalen Editor-/Autosave-Lifecycle ueberlassen

Wenn danach das Verschwinden aufhoert, war `active-persist-disk` der letzte
relevante Plugin-Trigger.
