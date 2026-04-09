# Android-Tests: Performance (Rest-Latenz ~8s)

Datum: 2026-04-09
Scope: nur die ~8s Rest-Latenz im overlapping-Loop.
Korrektheits-Thema ist in `android-tests-correctness.md` getrennt.

## Ausgangslage

Beispiel aus Android-Trace:

```text
initial-sync.partition         overlapping=807
initial-sync.overlapping.done  skippedVVMatch=806  elapsedMs=7928
```

806 von 807 Dateien werden per VV+Hash geskippt, der Loop braucht
trotzdem knapp 8s. Es gibt in der Zeit praktisch keine WS-Round-Trips,
keine CRDT-Ops, nur das Fast-Path-Verhalten.

## Hypothese der Rest-Latenz

```text
for (const file of overlappingFiles) {
  const effective = await readEffectiveLocalContent(app, editor, file);
  const effectiveHash = fnv1aHash(effective);
  ...
}
```

Pro Datei seriell:

1. `app.vault.read(file)` — I/O, via Android `fs` bzw. SAF
2. `fnv1aHash()` in JS auf dem kompletten Dateiinhalt

Bei 800 Dateien auf Android-Flash und mobiler JS-Engine kommt man in
genau diese Groessenordnung. Das matcht die Traces.

## Was wir **nicht** verdaechtigen

- **Android mtime** — wird nach `CLAUDE.md` ausdruecklich nicht als
  Caching-Signal benutzt. Keine mtime-basierten Fast-Path-Ideen.
- WS-Netzwerkzeit — `skippedVVMatch=806` bedeutet, fast kein Traffic.
- Loro-CPU — in dem Loop passiert kein CRDT-Import.
- `requestDocList` — eigener Schritt davor, nicht in den 7928ms.

## Relevante Code-Stellen

```text
src/sync-initial.ts
  - runInitialSync(), Overlapping-Loop               (Zeile ~263..307)
  - readEffectiveLocalContent()                      (Zeile ~34..42)
  - Fast-Path VV+Hash Skip                           (Zeile ~268..296)
  - trace-Event "initial-sync.vv-hash-skip"
  - trace-Event "initial-sync.overlapping.done"

src/conflict-utils.ts
  - fnv1aHash()

src/state-storage.ts
  - VVCacheEntry, loadVVCache/saveVVCache
```

Der Fast-Path selbst ist seit `cb7745e` korrekt (finaler Content-Hash,
nicht Pre-Sync-Hash). Der Engpass ist nicht die Logik, sondern das
serielle Durchlaufen pro Datei.

## Ziel der Android-Tests

1. Sicher bestaetigen, dass die Rest-Latenz aus Disk-Read + Hash kommt
   und nicht aus etwas anderem, was wir uebersehen.
2. Die Wirkung jedes Fix-Kandidaten auf realem Device messen
   (nicht nur Vitest).
3. Keine Korrektheit kaputtmachen (vv-cache korrekt, kein falscher Skip).

## Vorbereitung fuer die Android-Session

- BRAT auf die zu testende Version
- Vault `richardsachen` (repraesentative 800+ .md-Dateien)
- Vor jedem Messlauf: App wirklich killen, nicht nur in den Hintergrund
- Kein Split-View, kein aktives Editing, moeglichst "Cold-Start"
- Airplane-Mode lassen waere ideal, geht aber nur wenn der Server-Weg
  ganz aus der Messung raus soll — sonst WS aus dem Spiel: nicht moeglich
  weil initialSync ohne doc_list nicht zu den overlapping-Stats kommt

## Zusaetzliche Trace-Instrumentierung (vor den Tests einbauen)

Diese Events sind heute noch nicht in `sync-initial.ts` vorhanden und
fuer saubere Messungen noetig. **Reine Trace-Zeilen, keine
Verhaltensaenderung.**

```text
initial-sync.overlapping.begin
  data: { overlapping: <count> }

initial-sync.overlapping.progress  (alle ~100 Dateien)
  data: { done: <n>, skippedVVMatch: <n>, elapsedMs: <n> }

initial-sync.read.slow  (nur wenn eine einzelne Datei > 30ms braucht)
  path: <path>
  data: { readMs: <n>, bytes: <n> }

initial-sync.hash.slow  (nur wenn eine Hash-Op > 20ms braucht)
  path: <path>
  data: { hashMs: <n>, bytes: <n> }

initial-sync.phase-timings
  data: {
    docListMs: <n>,
    priorityMs: <n>,
    downloadsMs: <n>,
    overlappingMs: <n>,
    localOnlyMs: <n>,
    tombstonesMs: <n>,
    vvCacheSaveMs: <n>,
    orphansMs: <n>
  }
```

Diese Events muessen so eng wie moeglich um den zu messenden Block herum
liegen und duerfen keinen zusaetzlichen Await einfuegen.

## Testmatrix Android (Performance)

### P1 — Cold-Start, fully warm vv-cache
- vv-cache existiert, passt zu Server, passt zu Disk
- erwartet: **alle** overlapping-Dateien per VV+Hash-Skip
- Messung: `initial-sync.overlapping.done` elapsedMs
- Baseline-Wert festhalten — ueber 5 Runs Median nehmen.

### P2 — Cold-Start, vv-cache veraltet (VV-Mismatch)
- Vor dem Run ein Doc am Server aendern
- erwartet: 1 full-sync, Rest VV+Hash-Skip
- prueft, dass ein einzelner Mismatch den Loop nicht explodieren laesst.

### P3 — Cold-Start, Disk extern modifiziert
- Ausserhalb Obsidians ein paar Dateien aendern
- erwartet: VV passt, Hash nicht → Fall-Through in full-sync
- prueft, dass Hash-Mismatches die Zeit nicht unkontrolliert hochtreiben.

### P4 — vv-cache komplett fehlt
- `.obsidian/plugins/vaultcrdt/state/vv-cache.json` loeschen
- erwartet: alle Overlapping gehen in `overlap-sync`
- Obergrenze fuer schlimmsten Fall
- Wichtig als Referenz: so lang ist "ohne Fast-Path".

### P5 — Background/Foreground-Flip waehrend Messung
- Messung laeuft, App 1s in den Hintergrund, wieder vor
- Wichtig: Android kann JS-Scheduler pausieren — wenn die Messung
  dadurch 3-4s springt, ist ein Teil der "8s" in Wahrheit
  Scheduler-Stall, nicht echte CPU-/IO-Zeit.

### P6 — Fix-Kandidat: parallele Reads (P = 4)
- `Promise.all` ueber Batches von 4 Dateien im Fast-Path
- erwartet: elapsedMs deutlich kleiner auf P1
- Regressions-Check:
  - Reihenfolgeabhaengigkeiten im Loop existieren aktuell nicht
    (jeder Dateiblock schreibt nur in `contentHashes`, `lastServerVV`,
    `skippedVVMatch`)
  - keine WS-Aufrufe im Fast-Path → WS-FIFO-Garantien unberuehrt
- Messgroesse: gleiche vv-cache-Lage wie P1, Median ueber 5 Runs.

### P7 — Fix-Kandidat: parallele Reads (P = 8)
- Gleiche Messung, hoehere Parallelitaet
- Auf Mobile-Flash kann P=8 schlechter sein als P=4 (Kontention)
- Ziel: Sweet-Spot fuer Mobile finden, nicht Desktop.

### P8 — Fix-Kandidat: parallele Reads (P = 16)
- Nur um zu sehen ob Skalierung abflacht
- Nicht blind deployen.

### P9 — Fix-Kandidat: Hash auf `readBinary` + FNV ueber ArrayBuffer
- Aktuell: `vault.read()` (String) + `fnv1aHash(string)`
- Alternative: `vault.adapter.readBinary()` + FNV ueber Bytes
- Manchmal vermeidet das UTF-16-Konvertierung in der Obsidian-Schicht
- Nur testen wenn P6/P7 allein nicht genug bringen.

### P10 — Fix-Kandidat: Yielding per Batch
- Nach jedem Batch `await Promise.resolve()` oder
  `await new Promise(r => setTimeout(r, 0))`
- Ziel: UI bleibt interaktiv, gefuehlte Startup-Zeit sinkt, auch wenn die
  Gesamt-ms aehnlich bleiben
- Gefuehlte Messgroesse: Zeit bis die getippten Buchstaben erscheinen,
  nicht `initial-sync.complete`.

### P11 — Fix-Kandidat: Hash-Skip wenn `file.stat.size` == cachedSize
- **Achtung:** mtime ist tabu, aber size nicht.
- Wenn wir in vv-cache zusaetzlich `byteSize` persistieren, koennen wir
  bei `size === cachedSize && vv === cachedVV` optimistisch ueber den
  Read ueberspringen und den Hash nur bei size-Aenderung neu ziehen.
- Risiko: gleiche Groesse + anderer Inhalt (seltener Edit) wuerde
  geskippt.
- **Nur** testen, wenn P6..P10 nicht reichen, und nur mit zusaetzlichem
  Regressions-Check (siehe T-P6 unten).
- Entscheidung: Wenn wir size nehmen, muss das dokumentiert und im
  Memory-Vault als Konvention festgehalten werden.

### P12 — Fix-Kandidat: Priorisierte Teil-Latenz
- Statt des kompletten overlapping-Loops zuerst nur die aktive Datei
  sauber syncen (tun wir schon), danach `initial-sync.complete` frueher
  ausloesen und den Rest-Loop asynchron im Hintergrund weiterlaufen.
- Das verkuerzt nicht die Gesamtzeit, aber entfernt sie aus dem
  "Startup-Fenster" fuer den Nutzer
- Risiko: neue Broadcast-Race-Conditions, weil dann Editor-Edits
  gleichzeitig mit Fast-Path-Reads laufen
- Stark vorsichtig pruefen, ob das mit dem Korrektheits-Fix aus
  `android-tests-correctness.md` kollidiert.

### P13 — Nichts tun, nur Korrektheits-Fix
- Korrektheits-Fix alleine einspielen, keine Perf-Aenderung
- Messung: ist die gefuehlte "schlechte" Phase nach dem Korrektheits-Fix
  schon akzeptabel, weil das Tippen waehrend der 8s jetzt sauber bleibt?
- Falls ja: Perf-Thema kann erstmal ruhen. Falls nein: P6..P10 durchgehen.

## Vitest-Regression-Tests (vor den Android-Runs)

Die existierenden Perf-relevanten Tests sind:

```text
src/__tests__/sync-engine.test.ts
  - "skips CRDT sync when VV and content hash both match"
  - "persists the downloaded server text hash so the next sync can skip server-only docs"
  - "persists the final merged text hash instead of the stale pre-sync local text"
```

Neu hinzufuegen:

### T-P1 — Fast-Path ruft `vault.read` weiterhin einmal pro Datei
- Sicherstellen, dass parallele Reads nicht doppelt lesen.
- Nach dem Lauf: `mockVault.read.mock.calls.length === overlapping.length`.

### T-P2 — Fast-Path bleibt korrekt unter Parallelisierung
- 10 Dateien, alle mit korrektem VV+Hash im Cache
- erwartet: 0 `requestSyncStart`-Calls, 0 `writeToVault`-Calls
- egal bei welcher `PARALLEL` Konstante.

### T-P3 — Fast-Path bricht bei Hash-Mismatch sauber auf full-sync runter
- 10 Dateien, eine davon mit Hash-Mismatch
- erwartet: genau 1 `requestSyncStart` fuer diese eine Datei.

### T-P4 — vv-cache wird nach Parallelisierung korrekt persistiert
- alle `contentHashes`-Eintraege landen in `saveVVCache`
- keine leeren Eintraege
- keine doppelten Eintraege.

### T-P5 — Abbruch bei WS-Close im Fast-Path
- Heute prueft der Overlapping-Loop WS nicht
- Wenn wir parallelisieren, auch weiterhin kein frueher Abort im
  Fast-Path (Fast-Path braucht keinen WS), aber downstream muss
  Shutdown sauber bleiben.

### T-P6 — Size-Only-Skip (nur wenn P11 ernsthaft geplant)
- gleiche size, anderer Inhalt → Test muss durchgehen und **anschlagen**,
  wenn wir size-only-Skip einbauen ohne Hash-Fallback.
- Soll verhindern, dass wir einen stille Datenkorruption einbauen.

### T-P7 — Phase-Timings existieren in der Trace
- `initial-sync.phase-timings` erscheint genau einmal
- enthaelt alle Felder
- Vitest nutzt die Trace ueber `engine.getStartupTraceReport()`

## Trace-Auswertung Template

Pro Run aus der exportierten Trace festhalten:

```text
run:                <id>
vault:              richardsachen
plugin_version:     <x.y.z>
vv-cache present:   yes|no
overlapping:        <n>
skippedVVMatch:     <n>
overlappingMs:      <n>   (aus initial-sync.overlapping.done)
totalMs:            <n>   (aus initial-sync.complete)
docListMs:          <n>
priorityMs:         <n>
downloadsMs:        <n>
slow-reads (>30ms): <count>
slow-hashes(>20ms): <count>
```

Median ueber mindestens 5 Runs nehmen, Min/Max mit auswerten. Einzelne
Runs sind auf Android hochvariabel.

## Reihenfolge des echten Vorgehens

1. Trace-Instrumentierung einbauen (rein additiv, keine Logikaenderung)
2. Vitest T-P1..T-P4 + T-P7 schreiben, gruen
3. `bun run test && bunx tsc --noEmit && bun run build`
4. BRAT-Release als reine Messversion
5. P1..P4 auf Android (Baseline)
6. Parallelisierung implementieren, Vitest gruen
7. BRAT-Release mit Fix
8. P6, P7 messen, entscheiden welches P bleibt
9. Falls noetig P9/P10 gezielt testen
10. P11 nur nach explizitem Ruecksprache-Entscheid mit dem User
11. Neue Baseline im Handoff eintragen

## Was die Tests **nicht** sollen

- Nichts am Server veraendern oder eine Bulk-API einfuehren.
- Kein Cache auf Basis von Android-mtime.
- Kein Loro-Internals-Tuning.
- Keine Parallelisierung der Downloads-Phase mithochziehen — die ist
  schon auf `PARALLEL_DOWNLOADS = 5` und ist nicht der Engpass.
- Keine Messung "mit aktivem Tippen", das ist explizit Korrektheits-Scope.
- Nicht Performance und Korrektheit in einer BRAT-Version vermischen —
  der Erfolg eines Fixes muss an **einer** Variable pro Release haengen.
