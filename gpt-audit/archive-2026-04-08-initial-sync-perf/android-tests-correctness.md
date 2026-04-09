# Android-Tests: Korrektheit (Text verschwindet waehrend Startup)

Datum: 2026-04-09
Scope: nur das "Text verschwindet beim Tippen waehrend initialSync"-Problem.
Perf-Thema ist in `android-tests-performance.md` getrennt.

## Aktueller Stand (aus letzter Session)

- Letzter dokumentierter Plugin-Eingriff in der Trace fuer `test.md`:
  `overlap.active-persist-disk`.
- Nach `v0.2.28` kein Conflict-Fork mehr, kein aktiver Editor-Rewrite mehr,
  kein queued Broadcast mehr fuer `test.md`.
- Trotzdem verschwindet der Text spaeter noch kurz und taucht teils wieder
  auf, mit Plugin an. Ohne Plugin oeffnet `test.md` sofort sauber.
- Arbeitshypothese: `vault.modify()` auf die aktive Datei waehrend des
  Mobile-Startup-Fensters triggert ein Editor-Rebind/Reload, das die
  in-flight Tastatureingabe frisst.

## Relevante Code-Stellen

```text
src/sync-initial.ts
  - syncOverlappingDoc()
  - Branch "isActiveEditorDoc === true" + "editorAlreadyMatches"
  - trace-Event "overlap.active-persist-disk"           (Zeile ~596 und ~620)
  - wasEditedDuringStartup(path)                        (Zeile ~394)
  - priority-sync-Einstieg am Anfang von runInitialSync (Zeile ~177)

src/editor-integration.ts
  - writeToVault()
  - Shortcut "currentEditor === content" → nur Disk-Modify,
    kein setValue auf den Editor                        (Zeile ~36..61)
  - applyDiffToEditor()                                 (Zeile ~99..171)

src/sync-engine.ts
  - onFileChanged() setzt startupEditedPaths            (Zeile ~543..548)
  - startupEditedPaths wird in start()/initialSync() geleert
  - traceEditorChange() / ui.editor-change
```

`editedDuringStartup` und `isActiveEditorDoc` sind beide schon als Signale
im Code vorhanden. Ein enger Fix kann ausschliesslich in dem Branch
"isActiveEditorDoc && editorAlreadyMatches" ansetzen, ohne andere
Codepfade zu beruehren.

## Ziel der Android-Tests

Jeder Test soll eine der drei Fragen beantworten:

1. Ist `overlap.active-persist-disk` wirklich die letzte Plugin-Beruehrung,
   bevor der Text verschwindet? (Trace-Nachweis)
2. Verschwindet der Text auch dann, wenn wir diese eine Disk-Persist
   waehrend initialSync ueberspringen? (Fix-Verifikation)
3. Gibt es Sekundaereffekte, die der Fix kaputtmacht (Disk-Persist spaeter
   wirklich durchlaufen, keine Datenverluste, keine toten VV-Caches)?

## Vorbereitung fuer die Android-Session

- BRAT auf die zu testende Version
- `test.md` als aktive Datei vor Start auswaehlen
- Inhalt von `test.md` vor jedem Run auf einen bekannten Zustand bringen
  (z.B. "BASE")
- Server-Seite stabil, nur ein Peer
- Nach jedem Szenario:
  - VaultCRDT Command "Export last startup trace"
  - Trace + kurze Notiz (was getippt, was danach sichtbar) speichern

Die Trace-Datei muss zu jedem Szenario mitkommen, sonst ist der Durchlauf
wertlos.

## Testmatrix Android (Korrektheit)

### C1 — Baseline ohne Plugin
Plugin deaktiviert. `test.md` oeffnen, direkt tippen.
Erwartung:
- Datei oeffnet sofort, kein langsames Startfenster
- keine Eingabeverluste
- Bestaetigt: Obsidian allein ist nicht die Ursache.

### C2 — Baseline mit Plugin, kein Tippen
Plugin aktiv. `test.md` ist aktiv, aber **nichts tippen**.
Erwartung:
- `initial-sync.priority.begin` fuer `test.md`
- `overlap.active-persist-disk` oder kein Eingriff, je nachdem
- keine Inhaltsveraenderung sichtbar
- Bestaetigt: das reine Startup schadet `test.md` nicht, wenn man nichts tippt.

### C3 — Typen **vor** WS-Connect
Plugin aktiv. App oeffnen, sofort tippen, noch bevor irgendein
`ws.sync-delta` in der Trace kommt.
- `ui.editor-change accepted=true` erwartet
- `editedDuringStartup === true` fuer `test.md` erwartet
- Priority-Sync sollte passieren
- Erwartung nach Fix: kein `vault.modify` auf `test.md` in dieser Phase,
  Text bleibt vollstaendig sichtbar.

### C4 — Typen **waehrend** Priority-Sync
Plugin aktiv. App oeffnen, erst tippen wenn die Priority-Sync-Events
auftauchen (`initial-sync.priority.begin`, `overlap.begin`).
- kritischer Fall fuer Overlap/Merge
- Trace muss `overlap.concurrent-live-editor-merge` zeigen
- Erwartung nach Fix: kein Disk-Persist, Editor-Inhalt erhalten.

### C5 — Typen **nach** Priority-Sync, noch waehrend overlapping-Loop
Plugin aktiv. Warten bis Priority-Sync done, dann tippen waehrend die
seriellen VV+Hash-Skips laufen (`initial-sync.overlapping.done` noch nicht).
- prueft, dass Tippen in der "stillen" 8s-Phase nicht verloren geht
- Erwartung: keine Plugin-Schreibpfade auf `test.md`.

### C6 — Typen **nach** `initial-sync.complete`
Plugin aktiv. Warten bis Sync komplett, dann tippen.
- Normalverhalten
- Erwartung: Normaler Push-Pfad, keine Regression.

### C7 — Typen in **eine andere** offene, aber nicht-aktive Datei
Zwei Leaves im Split-View. `test.md` aktiv, `other.md` in
Background-Leaf. `other.md` hat schon lokalen Content.
Tippen in `other.md` waehrend initialSync.
- prueft, dass der Fix nicht versehentlich auch Background-Dateien einbezieht
- Erwartung: `readCurrentContent()` erkennt auch Background-Editor,
  Fall wird sauber gemerged.

### C8 — Typen in eine Datei, die gerade nichtueberlappt (nur lokal)
Datei existiert lokal, noch nicht am Server (`local-only`).
Tippen waehrend initialSync.
- prueft Push-Pfad
- Erwartung: `push.onFileChanged` landet, sauberer `doc_create`.

### C9 — App aus dem Hintergrund zurueckholen waehrend Startup
Plugin aktiv, App in den Hintergrund, nach 2-3s zurueckholen.
- Mobile-spezifisch: Obsidian triggert gerne Editor-Rebinds bei Focus
- Wichtig: Trace mitnehmen, sobald man wieder vorn ist
- Erwartung: kein Verlust, kein Konflikt-Fork.

### C10 — Netzwerkwechsel waehrend Startup
WLAN trennen, Mobile-Daten, oder Flugmodus-Toggle waehrend Startup.
- prueft, dass der WS-Reset nicht einen zweiten initialSync + Disk-Persist
  uebereinander legt, waehrend der Editor schon Text zeigt.

### C11 — Kein Sync-Schreibpfad mehr, Text verschwindet trotzdem?
Fix ist aktiv, Trace fuer `test.md` zeigt nach dem Fix **keinen**
Plugin-Schreibpfad (kein `active-persist-disk`, kein
`active-write-to-vault`, kein Broadcast, kein Conflict-Fork), aber der
Text verschwindet trotzdem.
- Wichtig: dann ist es sehr wahrscheinlich **nicht mehr** unser Bug,
  sondern ein Host-/Obsidian-Mobile-Rebind, den wir nur noch durch
  Workarounds (z.B. spaeteren Disk-Write nach `initial-sync.complete`)
  adressieren koennen.
- In dem Fall: Trace + Repro-Beschreibung hochqualifiziert dokumentieren,
  nicht weiter am Sync-Algorithmus drehen.

### C12 — Autosave-Verhalten nach Fix
Nach dem Fix: sicherstellen, dass der Editor-Inhalt **irgendwann** auch
wirklich auf Disk landet (Obsidian Autosave, oder manueller Wechsel der
Datei).
- Test: tippen in `test.md` waehrend Startup, dann anderes File oeffnen
- Erwartung: `test.md` liegt auf Disk mit dem erwarteten Text
- Verhindert den "Editor sieht Text, Disk bleibt leer"-Regressionsfall.

### C13 — Nachfolgender normaler Sync ist sauber
Nach C3/C4/C5 eine neue Sitzung starten.
- Trace muss `initial-sync.vv-hash-skip` fuer `test.md` zeigen (VV+Hash
  passen nach dem letzten Save).
- Verhindert, dass der Fix den vv-cache invalidiert (sonst kommt beim
  naechsten Start wieder die volle 8s-Phase).

## Trace-Checkliste pro Szenario

Pro Run manuell notieren (aus der Trace-Datei):

```text
[ ] ui.editor-change accepted=true (wenn getippt)
[ ] initial-sync.priority.begin path=test.md
[ ] overlap.begin path=test.md localLen=<?>
[ ] overlap.doc-state editedDuringStartup=<?>
[ ] overlap.concurrent-live-editor-merge (erwartet, kein conflict-Fork)
[ ] overlap.editor-mode isActiveEditorDoc=true
[ ] overlap.active-persist-disk  ← vor Fix ja, nach Fix: NEIN
[ ] overlap.apply-diff / overlap.active-write-to-vault
[ ] ws.sync-delta
[ ] initial-sync.complete
[ ] irgendein Plugin-Schreibpfad nach initialSync fuer test.md?
```

## Vitest-Regression-Tests (vor dem Android-Run erstellen)

Vorhandene relevante Tests:

```text
src/__tests__/sync-engine.test.ts
  - "startup editor typing merges instead of forking a conflict overwrite"
  - "active editor matching merged text completes without conflict fork"
  - "does not rewrite an open editor when it already shows the target content"
```

Neu hinzufuegen (klein und eng):

### T-C1 — Aktiver Editor-Fall: kein Disk-Modify waehrend initialSync
Setup:
- `getActiveViewOfType` gibt Leaf fuer `test.md` zurueck
- `readCurrentContent('test.md')` === serverContent nach Merge
- `editedDuringStartup === true`
- `mockVault.modify` scharf
Erwartung nach Fix:
- `mockVault.modify` wird **nicht** mit `test.md` aufgerufen, solange
  `initialSync` laeuft.
- `editor.setValue` wird **nicht** noch einmal aufgerufen.
- `lastServerVV` wird trotzdem korrekt aktualisiert.
- `docs.persist(path)` wird trotzdem aufgerufen (CRDT-State auf Disk).

### T-C2 — Aktiver Editor-Fall: Disk darf **nach** initialSync nachgezogen werden
- Autosave-simuliert: nach Ende initialSync Vault-Modify mit gemerged text
- Erwartung: kein Echo-Push, `lastRemoteWrite` konsistent.

### T-C3 — Nicht-aktiver Editor: Fix greift nicht
- `getActiveViewOfType` === `null` oder andere Datei
- Erwartung: `writeToVault` darf wie heute aufgerufen werden.

### T-C4 — Aktiver Editor, aber `editedDuringStartup === false`
- Erwartung: `writeToVault` darf aufgerufen werden, kein Skip.

### T-C5 — VV-Cache-Hash nach dem Fix
- Nach initialSync muss der Hash in vv-cache.json dem `editor`-Inhalt
  entsprechen, nicht dem stale Disk-Inhalt.
- Sonst triggert der naechste Startup wieder einen Full-Sync.

### T-C6 — Kein Conflict-Fork waehrend Fix-Pfad
- Explizit pruefen, dass `mockVault.create` keine `.conflict-*`-Datei
  erzeugt.

## Reihenfolge des echten Vorgehens

1. T-C1..T-C6 in Vitest implementieren und gruen bekommen
2. `bun run test && bunx tsc --noEmit && bun run build`
3. Fix in `sync-initial.ts` und ggfs. `editor-integration.ts`
4. Alle Vitest-Tests nochmal gruen
5. BRAT-Release bauen
6. Android-Szenarien C1..C13 durchlaufen, Traces sammeln
7. Auswertung: entweder Fix bestaetigt, oder Datenlage zeigt Host-Problem
   (dann nicht weiter am Sync drehen)

## Was die Tests **nicht** sollen

- Kein Test, der die Rest-Latenz misst, das ist Perf-Thema.
- Kein Test, der Bulk-API, Loro-Internas oder Server-Seite beruehrt.
- Kein Test, der `editor.setValue` gegen die aktive Datei akzeptiert
  solange `initialSync` laeuft (das ist explizit verboten nach Fix).
