# Conflict-Storm / Duplicate-Content Hardening — Plan

Status: Entwurf
Datum: 2026-04-08
Scope: primär `vaultcrdt-plugin`, plus kleine Rust/WASM-Änderung innerhalb desselben Repos

## 1. Problem in einem Satz

Das Plugin behandelt **gleichen Klartext** fälschlich als ausreichenden Beleg für **gleiche CRDT-Historie**. Wenn dabei lokaler State fehlt oder die Historien disjoint sind, kann der Merge statt Stabilisierung **Text verdoppeln** und danach massenhaft **Conflict-Dateien** erzeugen.

## 2. Beobachtetes Schadensbild

Im Vault `richardsachen` ist ein echter Massenfehler sichtbar:

- ca. **805 Conflict-Dateien** in einem Batch erzeugt
- passende **805 `.loro`-State-Dateien** für diese Conflict-Dateien
- die normalen Notizen sind großteils **inhaltlich doppelt hintereinander** gespeichert
- die Conflict-Dateien sind häufig die dazu passende abweichende Variante
- die aktuellen `.loro`-States passen bereits zur **verdoppelten** Version, also ist der Schaden nicht nur oberflächlich auf Dateiebene

Das ist kein Einzelfehler einer Notiz, sondern ein Architektur-Gap im Initial-Sync-/Conflict-Pfad.

## 3. Root Causes

### A. CRDT-Peer-Identität ist nicht stabil an den Loro-Doc gebunden

`src/wasm-bridge.ts` nimmt zwar `docUuid` und `peerId` entgegen, aber in Rust wird das aktuell ignoriert:

- `crates/vaultcrdt-wasm/src/lib.rs` reicht `doc_uuid` und `peer_id` an `SyncDocument::new(...)` durch
- `crates/vaultcrdt-crdt/src/document.rs` ignoriert beide Parameter aktuell vollständig
- `LoroDoc::new()` bekommt damit **keine stabile Peer-ID** aus den Plugin-Settings

Folge:

- ein neu erzeugter lokaler CRDT-Doc ist aus Sicht der Versionsvektoren nicht verlässlich an "dieses Gerät" gebunden
- bei fehlendem lokalem State oder Reset entsteht leicht eine **neue, unabhängige Historie** für denselben Pfad

### B. `peerId` wird nur im Settings-UI erzeugt, nicht als Startup-Invariante

Aktuell wird `peerId` in `src/settings.ts` nur erzeugt, wenn der Settings-Tab angezeigt wird.

`src/main.ts` lädt Settings, startet aber den Sync ohne die Invariante zu erzwingen.

Folge:

- ein Vault kann tatsächlich mit leerem `peerId` laufen
- selbst nach Fix von Root Cause A wäre das gefährlich, weil leere oder unstabile Peer-Identität zu früh in den Sync gelangt

### C. "Disjoint VV + gleicher Text => kein Fork" ist fachlich falsch

In `src/sync-initial.ts` existiert aktuell sinngemäß diese Denkweise:

- wenn `clientVV` und `serverVV` disjoint sind
- aber `serverText === localContent`
- dann wird **nicht** geforkt

Das ist als Optimierung plausibel gedacht, aber für CRDT-Historien falsch.

**Gleicher Text bedeutet nicht gleiche Geschichte.**

Zwei unabhängige CRDT-Historien mit identischem Klartext dürfen nicht blind zusammengeführt werden. Loro kann bei wirklich unabhängigen Inserts genau daraus **konkatenierte / verdoppelte Inhalte** machen.

### D. Beim fehlenden lokalen State wird zu früh synthetische lokale CRDT-Historie erzeugt

Im Overlap-Pfad passiert heute grob:

1. Datei existiert lokal, aber lokaler CRDT-State fehlt oder ist leer
2. Server hat ebenfalls ein Dokument
3. wenn nicht sofort ein Conflict erkannt wird, läuft `sync_from_disk(localContent)` auf einem frischen Doc
4. damit wird aus bloßem Klartext eine neue lokale CRDT-Historie erzeugt
5. danach wird gegen Server-Historie gemerged

Wenn die Server-Seite denselben Text mit anderer Historie bereits kennt, ist genau das der Weg in den Verdopplungsfehler.

## 4. Zielbild / Invarianten

Die dauerhafte Lösung sollte diese Invarianten haben:

1. **Jedes Gerät hat eine stabile CRDT-Peer-Identität.**
2. **Diese Identität existiert vor dem ersten Sync**, nicht erst nach Öffnen des Settings-Tabs.
3. **Klartext-Gleichheit ist nie Beweis für kausale Gleichheit.**
4. **Fehlender oder disjunkter lokaler State wird nicht durch Merge "gerettet"**, sondern durch bewusstes **Adoptieren** einer kanonischen Historie behandelt.
5. **Conflict-Dateien sind Ausnahmefälle**, nicht die Standardreaktion auf State-Verlust.

## 5. Empfehlung

Empfehlung ist eine Kombination aus drei Maßnahmen:

### Maßnahme 1 — stabile CRDT-Peer-ID wirklich an Loro binden

Die Plugin-`peerId` muss in eine stabile `u64`-Peer-ID für Loro überführt und beim Erzeugen jedes `SyncDocument` gesetzt werden.

### Maßnahme 2 — Startup-Invariante: `peerId` darf nie leer sein

`peerId` und `deviceName` müssen beim Laden/Start des Plugins erzeugt und gespeichert werden, nicht erst im Settings-Tab.

### Maßnahme 3 — disjoint / state-lost Pfade auf **Adopt**, nicht auf Merge

Wenn lokaler State fehlt oder die Historie disjoint ist, darf gleicher Text nicht zu einem Merge führen. Stattdessen:

- **gleicher Text** -> **Server-Historie adoptieren**, kein Conflict, kein Merge
- **anderer Text** -> Conflict-Datei für lokale Version, danach Server-Historie adoptieren

Das ist architektonisch klarer und in der Praxis robuster.

## 6. Konkreter Implementierungsplan

## Phase 1 — stabile Peer-Identität erzwingen

### 1.1 `src/main.ts` / Settings-Lifecycle

Neue Startup-Invariante direkt nach `loadSettings()`:

- wenn `settings.peerId` leer ist -> `crypto.randomUUID()` erzeugen
- wenn `settings.deviceName` leer ist -> Default erzeugen
- sofort `saveSettings()`

Wichtig: **nicht** mehr nur in `VaultCRDTSettingsTab.display()`.

Der Settings-Tab darf die Werte weiter anzeigen, aber nicht mehr der primäre Erzeugungsort sein.

### 1.2 Rust: `SyncDocument::new(doc_uuid, peer_id)` wirklich nutzen

In `crates/vaultcrdt-crdt/src/document.rs`:

- `peer_id` nicht mehr ignorieren
- aus dem String eine stabile `u64` ableiten
- `doc.set_peer_id(...)` aufrufen

Pragmatische robuste Ableitung:

- wenn String numerisch parsebar ist -> direkt nutzen
- sonst stabiler 64-bit-Hash des Strings
- ungültige Sonderwerte vermeiden (`PeerID::MAX` o.ä.)

Beispiel-Invariante:

- gleicher Settings-`peerId`-String -> gleiche Loro-Peer-ID
- anderer String -> andere Loro-Peer-ID

### 1.3 Testabdeckung dafür

Rust-Tests:

1. **same string => same derived peer id**
2. **different strings => different derived peer ids**
3. **document created with fixed peer id exports VV under same peer after edits**
4. **restart case**: neues `SyncDocument` mit gleicher peerId + importiertem Snapshot macht weitere Edits auf derselben Peer-Linie weiter

TS-Tests:

5. **plugin startup generates peerId before sync start when empty**

## Phase 2 — fehlender State: equal text => adopt server, nicht mergen

### 2.1 `syncOverlappingDoc()` neu strukturieren

Aktuell wird bei fehlendem persisted state zu früh `sync_from_disk(localContent)` aufgerufen.

Stattdessen den Overlap-Fall in zwei Klassen teilen:

#### Klasse A — lokaler CRDT-State fehlt (`hadPersistedState === false`)

Wenn der Server für denselben Pfad bereits Inhalt hat:

- `requestSyncStart(path, null)` holen
- Servertext aus Temp-Doc lesen
- dann:

**Fall A1: `serverText === localContent`**
- **kein Conflict**
- **nicht** `sync_from_disk(localContent)` auf frischem Doc
- stattdessen lokalen Doc direkt mit Server-Snapshot initialisieren
- `lastServerVV` setzen
- `docs.persist(path)`
- optional `writeToVault` nur wenn nötig
- return

**Fall A2: `serverText !== localContent`**
- Conflict-Datei mit lokaler Version anlegen
- lokalen State verwerfen / frischen Doc nehmen
- Server-Snapshot adoptieren
- persistieren
- return

Das ist die wichtigste direkte Härtung gegen State-Loss + identischen Text.

## Phase 3 — disjoint VV: equal text => adopt server, nicht mergen

### 3.1 aktuelle Logik ersetzen

Im disjoint-VV-Pfad gilt künftig:

Wenn
- `clientVV !== '{}'`
- `!hasSharedHistory(clientVV, result.serverVV)`

Dann ist das **kein Merge-Pfad** mehr.

Stattdessen:

**Fall B1: `serverText === localContent`**
- **kein Conflict**
- lokalen disjunkten State verwerfen
- Server-Snapshot full-adopt
- persistieren
- return

**Fall B2: `serverText !== localContent`**
- Conflict-Datei mit lokaler Version
- lokalen disjunkten State verwerfen
- Server-Snapshot adoptieren
- persistieren
- return

Wichtig: In beiden Fällen wird **nicht** versucht, zwei disjunkte Historien zusammenzuführen.

### 3.2 Leitregel

**Plaintext equality may justify adoption, never causal merge.**

Das ist die zentrale Regel, die den beobachteten Fehler dauerhaft verhindert.

## Phase 4 — Tests für die beobachtete Fehlerklasse

### Pflichtfälle in `src/__tests__/sync-engine.test.ts` / `sync-engine-edge.test.ts`

1. **missing local state + same text + server doc -> adopt server, no conflict**
   - Assertion:
     - kein Conflict-File
     - kein `sync_from_disk(localContent)` auf leerem Doc als Merge-Vorstufe
     - finaler Inhalt bleibt einfach, nicht doppelt

2. **missing local state + different text + server doc -> conflict + adopt server**

3. **disjoint VV + same text -> no conflict, adopt server**
   - das ist der direkte Regressionsfall gegen die aktuelle falsche `no fork when disjoint VVs but same content`-Logik

4. **disjoint VV + different text -> conflict + adopt server**

5. **same peerId persists across restart**
   - VV-Peer vor und nach Reopen identisch

6. **startup with empty peerId generates one before engine.start()**

### Rust-Pflichttest

7. **true concurrent equal-text histories must not be considered merge-safe by plugin semantics**

Das ist eher ein Dokumentationstest auf CRDT-Ebene: gleiche Endtexte sind kein Beweis für gleiche Historie.

## 7. Minimal-Alternative und warum sie nicht reicht

### Minimal-Hotfix A

Einfach nur den aktuellen Fall

- `disjoint VV + same text => no fork`

in

- `disjoint VV + same text => conflict`

ändern.

### Warum das nicht reicht

Das stoppt zwar die stille Verdopplung, aber nicht das Grundproblem:

- fehlender lokaler State würde dann immer noch unnötig zu Massen-Conflicts führen
- stabile Peer-Identität wäre weiter ungeklärt
- leerer `peerId` beim Startup bliebe möglich

Das wäre ein Notnagel, aber keine Lösung, die "jahrelang halten" soll.

## 8. Architektonische Zusatzfrage: gehört `peerId` überhaupt in vault-lokale Plugin-Settings?

Langfristig ist das die eine offene Strukturfrage.

Aktuell liegt `peerId` in `.obsidian/plugins/vaultcrdt/data.json`, also vault-lokal. Wenn man ein Vault klont oder mitsamt Plugin-Konfig kopiert, kopiert man damit auch die Geräteidentität.

Für die jetzige Härtung ist das **noch nicht zwingend** zu ändern. Aber langfristig wäre sauberer:

- **vault-lokal:** `serverUrl`, `vaultId`, `vaultSecret`, Sync-Settings
- **device-lokal:** `peerId`, `deviceName`

Wenn Obsidian dafür keine saubere plattformübergreifende device-lokale Storage-API bietet, ist zumindest nötig:

- `peerId` beim Startup strikt erzwingen
- Duplikate leichter erkennbar machen
- später bewusst entscheiden, ob eine device-lokale Ablage nachgezogen wird

Das ist ein **Phase-2-nach-der-Härtung**-Thema, nicht Voraussetzung für den ersten Fix.

## 9. Rollout / Recovery-Hinweis

Der Code-Fix allein heilt den aktuell beschädigten Vault nicht automatisch.

Wenn dieser Plan implementiert ist, sollte für den betroffenen Dev-Vault separat entschieden werden:

- welche Kopie die Source of Truth ist
- ob Server + lokale States komplett neu gesetzt werden

Für die Code-Arbeit ist aber wichtig:

**Der Fix darf nicht versuchen, den aktuellen Schaden still "wegzu-mergen".**
Der Fix muss die Architektur so ändern, dass dieselbe Fehlerklasse künftig gar nicht mehr entsteht.

## 10. Klare Entscheidungsempfehlung

Empfohlen:

1. **Startup-Invariante für `peerId`/`deviceName`**
2. **stabile Loro-Peer-ID aus Plugin-`peerId` ableiten und wirklich setzen**
3. **equal text bei missing/disjoint history => adopt server, never merge**
4. **bestehenden Test `no fork when disjoint VVs but same content` ersetzen** durch die neue Adopt-Semantik

Das ist die kleinste Lösung, die strukturell tragfähig ist und nicht nur den aktuellen Unfall kaschiert.
