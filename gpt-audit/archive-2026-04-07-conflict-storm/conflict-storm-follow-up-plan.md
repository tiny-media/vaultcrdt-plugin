# Conflict-Storm-Haertung — Follow-up-Plan vor Commit

Status: Entwurf
Datum: 2026-04-08
Bezug:
- `gpt-audit/conflict-storm-plan.md`
- unkommittierte Implementation von Claude Opus

## 1. Ziel dieses Follow-ups

Die aktuelle Implementation geht in die **richtige Richtung** und behebt sehr wahrscheinlich die eigentliche Fehlerklasse:

- stabile Loro-Peer-ID statt implizitem Zufall
- Startup-Invariante fuer `peerId` und `deviceName`
- **Adopt statt Merge** bei fehlendem lokalem State und bei disjunkter Historie

Vor einem Commit sollten aber noch drei Dinge sauber gemacht werden, damit der Fix nicht nur "funktioniert", sondern auch **langfristig tragfaehig** ist:

1. **Repo-Invariante wiederherstellen:** `wasm-bindgen` ist aktuell auf `0.2.117`, die Projektregel verlangt exakt `=0.2.114`.
2. **Active-Editor-/stale-disk-Edge-Case absichern:** die neue Adopt-Entscheidung darf nicht auf veraltetem Disk-Content basieren, wenn in einem offenen Editor neuere, noch nicht auf Disk persistierte Aenderungen liegen.
3. **Tests nachschaerfen:** zwei wichtige Invarianten sind aktuell nur implizit oder in Kommentaren abgesichert, aber nicht explizit getestet.

Dieser Plan ist bewusst **Follow-up scoped**. Er soll nicht die ganze Architektur nochmal aufmachen.

## 2. Was explizit NICHT Teil dieses Follow-ups ist

Nicht in diesen Plan ziehen:

- Server-Aenderungen
- neue Protokoll-Frames
- die spaetere Grossfrage "peerId vault-lokal vs device-lokal"
- repo-weite Altlasten aus `verify_plugin` wie Emoji- oder Built-in-Bun-Test-Runner-Findings in alten Audit-Dokumenten

Die eine repo-weite Invariante, die **sehr wohl** in diesen Plan gehoert, ist allein:

- **`wasm-bindgen = "=0.2.114"` exakt wiederherstellen**

## 3. P0 — Hard Blocker: `wasm-bindgen`-Pin wieder auf Projekt-Invariante bringen

## Problem

`verify_plugin` meldet aktuell:

- `FAIL cargo-pin: wasm-bindgen pin ist 0.2.117, erwartet 0.2.114`

Das ist keine kosmetische Abweichung, sondern eine explizite Repo-Regel.

## Ziel

Vor Commit muss der Repo-Zustand wieder konsistent mit den Regeln sein:

- `Cargo.toml` pinnt `wasm-bindgen = "=0.2.114"`
- `Cargo.lock` passt dazu
- `bun run wasm` wurde danach neu ausgefuehrt
- `bun run wasm:check` ist wieder gruen
- `verify_plugin` faellt an diesem Punkt nicht mehr durch

## Konkrete Schritte

1. `Cargo.toml`
   - `[workspace.dependencies] wasm-bindgen = "=0.2.114"`

2. `Cargo.lock`
   - sauber mit dem Pin synchronisieren

3. WASM neu bauen
   - `bun run wasm`
   - nicht manuell in `wasm/` editieren

4. Verifikation
   - `bun run wasm:check`
   - `cargo test --workspace`
   - `verify_plugin`

## Wichtiger Scope-Hinweis

Wenn sich herausstellt, dass `0.2.117` absichtlich repo-weit eingefuehrt wurde, dann darf das **nicht still nebenbei** in diesem Fix passieren. Dann muss die Invariante bewusst geaendert werden. Solange das nicht explizit entschieden ist, gilt: **auf `0.2.114` zurueck**.

## 4. P1 — Active-Editor-/stale-disk-Problem vor der Adopt-Entscheidung schliessen

## Problem

Die neue Adopt-Logik in `src/sync-initial.ts` entscheidet derzeit mit `localContent`, das aus dem Initial-Sync-Pfad typischerweise via `app.vault.read(file)` kommt.

Das ist fuer normale Files okay, aber nicht fuer offene Editoren mit noch nicht auf Disk persistiertem Inhalt.

Besonders kritisch ist das jetzt in genau den neuen Pfaden:

- **Phase 2**: fehlender lokaler CRDT-State
- **Phase 3**: disjunkte VV

Dort wird jetzt **frueh** entschieden:

- `texts equal -> adopt server`
- `texts differ -> conflict + adopt`

Wenn `localContent` an dieser Stelle stale ist, kann die Entscheidung falsch sein.

### Konkretes Risikoszenario

1. Datei ist in einem offenen Editor.
2. Nutzer hat lokale, noch nicht auf Disk geschriebene Aenderungen.
3. Reconnect / Initial-Sync startet.
4. `localContent` wird von Disk gelesen, nicht aus dem Editor.
5. Phase 2 oder 3 vergleicht Servertext mit stale Disk-Text.
6. Plugin trifft eine falsche Adopt-/Conflict-Entscheidung.

Das ist genau die Sorte Randfall, die spaeter zu "selten, aber furchtbar" fuehrt.

## Ziel

**Jede Conflict-/Adopt-Entscheidung muss auf dem frischesten lokalen Text basieren.**

Nicht auf stale Disk-Inhalt, wenn im Editor bereits neuere Daten existieren.

## Empfehlung

Die Loesung sollte **nicht** nur lokal in `syncOverlappingDoc()` reingefrickelt werden, sondern sauber am Content-Eintrittspunkt passieren.

### 4.1 Neue Hilfsfunktion fuer "effektiven lokalen Text"

Entweder in `sync-initial.ts` oder in `editor-integration.ts` eine kleine Hilfsfunktion einfuehren, sinngemaess:

```ts
async function readEffectiveLocalContent(
  app: App,
  editor: EditorIntegration,
  file: TFile,
): Promise<string> {
  return editor.readCurrentContent(file.path) ?? await app.vault.read(file);
}
```

Wichtig:

- nicht nur `getActiveEditorPath()`, sondern **alle offenen Leaves** beruecksichtigen
- `EditorIntegration.readCurrentContent(path)` kann das bereits

### 4.2 Diese Hilfsfunktion an allen relevanten Initial-Sync-Stellen verwenden

Nicht nur in einem einzelnen Sonderfall, sondern konsistent in `runInitialSync()`:

1. **Priority sync des aktiven Dokuments**
   - statt `vault.read(file)` den effektiven lokalen Text holen
   - auch `contentHashes.set(...)` auf diesem effektiven Text basieren lassen

2. **Overlapping docs loop**
   - bei jedem File den effektiven lokalen Text holen
   - denselben Text an `syncOverlappingDoc(...)` uebergeben
   - denselben Text fuer `contentHashes` verwenden

3. **Local-only docs loop**
   - auch hier editor-first lesen
   - sonst kann ein offenes, lokal-only Dokument mit stale Disk-Inhalt als `doc_create` rausgehen

### 4.3 Belt-and-suspenders in `syncOverlappingDoc()`

Selbst wenn die Caller schon den richtigen Text liefern, kann `syncOverlappingDoc()` am Anfang defensiv nochmal sagen:

```ts
const freshEditorContent = editor.readCurrentContent(path);
if (freshEditorContent !== null) {
  localContent = freshEditorContent;
}
```

Das ist kein Ersatz fuer 4.2, aber ein robuster Guard.

## Warum das besser ist als nur den Active-Doc-Sonderfall zu patchen

Weil auch ein **offenes, aber nicht aktives** Dokument betroffen sein kann. `readCurrentContent(path)` iteriert sowieso ueber alle Leaves. Wenn wir schon haerten, dann richtig.

## 5. P2 — Tests fuer die neuen Invarianten explizit machen

## Problem A

Die neue Startup-Invariante

- `peerId` und `deviceName` existieren vor `new SyncEngine(...)`

ist aktuell code-seitig sinnvoll, aber nicht explizit testbar gemacht.

## Problem B

Mindestens ein neuer Test kommentiert zwar ein wichtiges Verhalten,
assertet es aber nicht wirklich:

- "Phase 2 issues exactly ONE sync_start"

Wenn das wichtig genug fuer den Kommentar ist, ist es wichtig genug fuer eine echte Assertion.

## Ziel

Die neuen Architekturentscheidungen sollen als **kleine, direkte Tests** abgesichert werden, nicht nur indirekt ueber grosse End-to-End-Wege.

## Empfehlung

### 5.1 Startup-Invariante testbar extrahieren

Statt die Identitaets-Erzeugung nur inline in `main.ts::loadSettings()` zu lassen, eine kleine pure Helper-Funktion extrahieren.

Beispiel:

```ts
export function ensureDeviceIdentity(
  settings: VaultCRDTSettings,
  genPeerId: () => string = () => crypto.randomUUID(),
  genDeviceName: () => string = defaultDeviceName(),
): boolean {
  let changed = false;
  if (!settings.peerId) {
    settings.peerId = genPeerId();
    changed = true;
  }
  if (!settings.deviceName) {
    settings.deviceName = genDeviceName();
    changed = true;
  }
  return changed;
}
```

Dann in `main.ts`:

- Helper aufrufen
- wenn `changed`, `saveSettings()`

### 5.2 Direkte Tests fuer diese Helper-Funktion

Neue kleine Testdatei, z.B. `src/__tests__/settings-identity.test.ts` oder `main-settings.test.ts`:

Pflichtfaelle:

1. **fills missing peerId and deviceName**
2. **does not overwrite existing values**
3. **returns changed=false when nothing was missing**
4. **returns changed=true when one or both fields were missing**

Das ist wesentlich einfacher und stabiler als einen vollen Plugin-Lifecycle fuer diesen einen Punkt zu mocken.

### 5.3 Phase-2-Test wirklich schaerfen

Im bestehenden Test

- `missing local CRDT + same text -> adopt server, no conflict, no resync`

zusatzlich wirklich assertieren:

- genau **ein** `sync_start` fuer diesen Pfad

Beispiel:

```ts
const syncStartCalls = mockEncode.mock.calls.filter(
  (c: any[]) => c[0]?.type === 'sync_start' && c[0]?.doc_uuid === 'state-lost.md'
);
expect(syncStartCalls.length).toBe(1);
expect(syncStartCalls[0][0].client_vv).toBeNull();
```

### 5.4 Einen Test fuer den dokumentierten Fall-through nachziehen

Aktuell gibt es im Code einen gut begruendeten Kommentar fuer:

- probe `null` oder leeres `delta`
- dann Fall-through in den normalen local-create-Pfad

Wenn das Verhalten bewusst ist, sollte es mindestens **einen** Test geben.

Pflichtfall:

- **missing local state + probe null/empty -> falls through to local create path**

Assertions:

- kein Conflict-File
- `sync_from_disk(localContent)` darf in diesem Sonderfall wieder passieren
- lokaler Push/Create-Pfad wird normal verwendet

Damit ist der Kommentar nicht nur Dokumentation, sondern verifiziertes Verhalten.

## 6. P3 — Neue Tests fuer das eigentliche stale-editor-Risiko

Wenn Phase 1 umgesetzt wird, braucht sie direkte Regressionstests.

## Pflicht-Testfaelle

### 6.1 Disjoint VV + Disk stale + Editor fresh differs -> Konflikt basiert auf Editor-Text

Szenario:

- Datei offen im Editor
- `vault.read(file)` liefert alten Text
- `editor.readCurrentContent(path)` liefert neuen Text
- Servertext ist gleich dem alten Text, aber ungleich dem Editor-Text
- disjunkte VV

Erwartung:

- **kein stilles Adopt wegen stale Disk-Text**
- stattdessen Conflict-Datei mit dem **Editor-Text**

### 6.2 Missing local state + Disk stale + Editor fresh differs -> Konflikt basiert auf Editor-Text

Gleiches Prinzip fuer Phase 2.

### 6.3 Local-only open doc uses editor content for `doc_create`

Wenn der Initial-Sync ohnehin editor-first liest, dann bitte auch dafuer Testschutz:

- local-only file
- Disk stale, Editor fresh
- `doc_create`/Snapshot basiert auf Editor-Text, nicht auf Disk-Text

## Optional, falls leicht testbar

### 6.4 Open but not active leaf is still preferred over disk

Nicht nur `activeDoc`, sondern irgendein offenes Leaf fuer denselben Pfad.

Wenn das Test-Setup das sauber hergibt, waere das ein sehr guter Guard gegen spaetere Regression auf "nur active editor".

## 7. P4 — Kleine Codehygiene im selben Atemzug

Keine grosse Refaktorierung, nur zwei kleine Scharfstellungen:

### 7.1 Marker-Strings zentralisieren

Die neuen Probe-Dokumente nutzen mehrfach:

- `createDocument('__probe__', '__probe__')`

Das ist okay, aber als mehrfaches Literal unnötig fragil.

Besser:

```ts
const PROBE_DOC_UUID = '__probe__';
const PROBE_PEER_ID = '__probe__';
```

am Kopf der Datei oder in einem kleinen lokalen Helper.

### 7.2 Kommentar an der richtigen Stelle dokumentieren

Der wichtigste neue Satz sollte im Code glasklar stehen:

**Plaintext equality may justify adoption, never causal merge.**

Das ist schon sinngemaess da und sollte unbedingt erhalten bleiben.

## 8. Commit-Strategie

Empfohlene Reihenfolge:

### Commit 1 — Invariante / Build-Konsistenz

Scope:

- `Cargo.toml`
- `Cargo.lock`
- `wasm/`

Commit-Idee:

- `build(wasm): restore wasm-bindgen pin to 0.2.114`

### Commit 2 — Plugin-Korrektheit + Tests

Scope:

- `src/main.ts`
- ggf. extrahierter Helper + neue Tests
- `src/sync-initial.ts`
- betroffene Testdateien
- `main.js`

Commit-Idee:

- `fix(sync): use editor content for adopt decisions during initial sync`
- oder, falls der Startup-Helper in denselben Commit geht:
- `fix(sync): harden adopt path against stale editor state`

### Commit 3 — nur falls noetig

- kleiner Docs-/Handoff-Commit separat
- nur Status, keine lange Audit-Rationale in `next-session-handoff.md`

## 9. Verifikation nach Umsetzung

Reihenfolge:

1. `cargo fmt --all`
2. `cargo clippy --all-targets --workspace -- -D warnings`
3. `cargo test --workspace`
4. `bun run wasm`
5. `bun run wasm:check`
6. `bun run test`
7. `bun run build`
8. `verify_plugin`

Zielzustand fuer diesen Follow-up:

- `cargo-pin` nicht mehr FAIL
- aktive Editorinhalte koennen die neue Adopt-Entscheidung nicht mehr mit stale Disk-Text fehlleiten
- Startup-Invariante ist explizit getestet
- Phase-2-Einmaligkeit und Fall-through sind explizit getestet

## 10. Entscheidungsregel fuer den Reviewer

Wenn nach diesem Follow-up noch etwas offen bleibt, sollte die Bewertung so ausfallen:

### Commitbar

wenn

- `wasm-bindgen` wieder korrekt gepinnt ist
- editor-first-Content im Initial-Sync fuer die neuen Adopt-Pfade verwendet wird
- die drei Testluecken geschlossen sind

### Noch nicht commitbar

wenn

- `wasm-bindgen` weiter auf `0.2.117` steht
- Adopt-Entscheidungen weiter auf stale Disk-Content basieren koennen
- die neue Startup-Invariante nur ungetestet "hoffentlich" gilt
