# Next Session — VaultCRDT Stand 2026-03-25 (v0.2.10)

## Repos & Versionen

| Repo | Version | Pfad |
|------|---------|------|
| Plugin | v0.2.10 | `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin) |
| Server | v0.2.3 | `/home/richard/projects/vaultcrdt-server/` (GitHub: tiny-media/vaultcrdt-server) |
| Fleet | — | `/home/richard/fleet/` (Gitea: git.fryy.de/richard/fleet) |

Server deployed auf `home` via Docker Compose, erreichbar unter `https://obsidian-sync.hyys.de`.

## Aktive Vaults

| Vault | Pfad | peerId | vaultId |
|-------|------|--------|---------|
| vault-a (Test) | `~/vault-a/` | `1` | `testvaults-a-b` |
| vault-b (Test) | `~/vault-b/` | `2` | `testvaults-a-b` |
| richardsachen (Laptop) | `~/CloudOrdner/Obsidian/richardsachen/` | `richardlaptop` | `richardsachen` |
| richardsachen (Handy) | `~/Dokumente/obsidian-plugins/vaultcrdt/` (synced) | `richardhandy` | `richardsachen` |

---

## PRIORITÄT 1 — "Typing during initialSync" Problem lösen

### Aktueller Stand (v0.2.10)
Text verschwindet nicht mehr, aber das aktiv editierte Dokument "verschluckt" sich — Keystrokes gehen verloren oder werden nicht zum Server gepusht. Nach initialSync sind Laptop und Handy out-of-sync.

### Was wir versucht haben (v0.2.8–v0.2.10) und warum es nicht reicht

Alle bisherigen Fixes adressieren Symptome, nicht das Grundproblem:

| Version | Fix | Ergebnis |
|---------|-----|----------|
| v0.2.8 | `text_matches()` Guard vor `sync_from_disk` | Ghost-Pushes gefixt |
| v0.2.9 | Editor-Buffer statt `vault.read()`, Push-Deferral, reconcileOpenEditors | Stale-Content gefixt, aber Conflict Detection killt Typing |
| v0.2.10 | `isLiveEdit` Flag überspringt Conflict Detection | Kein Datenverlust mehr, ABER: "verschluckt" sich, Sync bricht ab |

### Das Grundproblem

**`sync_from_disk` ist eine Replace-Operation, kein Merge.** Es erzeugt CRDT-Ops die den Text zum Argument transformieren. Wenn der CRDT nach `import_snapshot(serverDelta)` Server-Änderungen hat und wir `sync_from_disk(editorContent)` aufrufen, erzeugt das DELETE-Ops für die Server-Änderungen.

Das bedeutet: **Wir können `sync_from_disk` nicht sicher aufrufen NACHDEM wir Server-Änderungen importiert haben**, wenn der Editor-Content die Server-Änderungen nicht enthält.

Die einzige sichere Reihenfolge ist:
1. `sync_from_disk(localContent)` — CRDT bekommt lokale Edits
2. `import_snapshot(serverDelta)` — CRDT merged lokal + server (Loro-CRDT handled das korrekt)
3. `get_text()` — merged Ergebnis
4. `writeToVault(merged)` — Editor zeigt Merge-Ergebnis

Aber zwischen Schritt 1 und 4 kann der User weiter tippen. Diese Keystrokes landen im Editor-Buffer, sind aber nicht im CRDT. Wenn dann `writeToVault(merged)` den Editor überschreibt, gehen die Zwischenzeitlichen Keystrokes verloren.

### Lösungsansätze für nächste Session

**Ansatz A: "Hot Doc" — aktiv editiertes Doc aus initialSync herausnehmen**
- Vor der Overlapping-Loop: prüfe welche Docs gerade im Editor offen sind
- Diese Docs werden NICHT in der Overlapping-Loop verarbeitet
- Stattdessen: nach initialSync, ein separater `syncHotDoc(path)` der:
  1. Server-Delta holt (sync_start)
  2. import_snapshot in den CRDT (ohne sync_from_disk vorher!)
  3. Den Merge-Result als surgical diff auf den Editor anwendet (via `import_and_diff`)
  4. Dann den aktuellen Editor-Content ins CRDT synct
- Vorteil: Der Editor wird nie mit `setValue()` überschrieben, nur surgical diffs
- Nachteil: Komplexer, braucht Sonderbehandlung

**Ansatz B: "Pause Editor" — kurze Sperre für das aktive Doc**
- Wenn syncOverlappingDoc ein offenes Doc verarbeitet:
  1. `readCurrentContent()` → aktueller Editor-Stand
  2. `sync_from_disk(editorContent)` → CRDT hat alles vom Editor
  3. Zeige kurz einen Lock-Indicator (z.B. "Syncing..." Banner)
  4. `requestSyncStart` + `import_snapshot` → CRDT hat Server + Editor
  5. `writeToVault(merged)` → Editor bekommt Merge-Ergebnis
  6. Lock aufheben
- Keystrokes während der Sperre werden von Obsidian gepuffert
- Sperre dauert nur den Server-Roundtrip (~100-500ms)
- Vorteil: Einfach, korrekt, keine Sonderbehandlung
- Nachteil: Kurzes "Stottern" beim Tippen, nicht ganz "smooth"

**Ansatz C: "Broadcast statt initialSync für Hot Docs"**
- Hot Docs (im Editor offen) werden komplett aus initialSync rausgenommen
- Server-Änderungen kommen stattdessen via delta_broadcast (nach initialSync)
- delta_broadcast nutzt bereits `import_and_diff` + `applyDiffToEditor` (surgical diffs!)
- Das ist der Broadcast-Pfad der schon funktioniert und getestet ist
- Vorteil: Nutzt bestehenden, getesteten Code-Pfad; kein `setValue()`
- Nachteil: Server-Änderungen für Hot Docs erscheinen erst nach initialSync
- **Das ist vermutlich der beste Ansatz** — einfach, sicher, nutzt was da ist

**Ansatz D: "WASM-Level Merge" — sync_from_disk ersetzen**
- Neue WASM-Methode: `merge_concurrent_edit(baseText, editedText)` die:
  1. Diff zwischen baseText und editedText berechnet
  2. Nur die Diff-Ops als CRDT-Ops einfügt (nicht den ganzen Text ersetzt)
  3. Existierende CRDT-Ops (Server-Änderungen) bleiben erhalten
- Vorteil: Korrekteste Lösung, echtes concurrent editing
- Nachteil: Rust-WASM Änderung nötig, komplex

### Empfehlung: Ansatz C ("Broadcast statt initialSync für Hot Docs")

Warum:
- **Null Risiko für Textverlust** — wir fassen den Editor nicht an während initialSync
- **Nutzt bestehenden Code** — `onDeltaBroadcast` → `import_and_diff` → `applyDiffToEditor` ist getestet
- **Kein "Stottern"** — User tippt smooth weiter, Server-Änderungen kommen per surgical diff
- **Einfache Implementierung**:

```typescript
// In der Overlapping-Loop:
const editorContent = this.editor.readCurrentContent(file.path);
if (editorContent !== null) {
  // Hot doc — skip in initialSync, will sync via broadcast after
  hotDocPaths.add(file.path);
  contentHashes.set(file.path, fnv1aHash(editorContent));
  stepsDone++;
  continue;
}
// ... normal processing for non-hot docs ...

// Nach initialSync, im finally-Block:
for (const path of hotDocPaths) {
  await this.syncHotDoc(path);
}
```

`syncHotDoc(path)`:
1. Lies aktuellen Editor-Content
2. Lade CRDT via getOrLoad
3. sync_from_disk(editorContent) — CRDT hat User-Typing
4. sync_start → bekomme Server-Delta
5. import_and_diff(serverDelta) → bekomme surgical diff
6. applyDiffToEditor(path, diff, doc.get_text()) — surgical Editor-Update
7. Push VV-Gap delta an Server
8. Persist

### Verbleibende Fragen
- Was passiert wenn der User WÄHREND syncHotDoc tippt? (Gleiche Race wie vorher, aber kleiner weil nur ein Server-Roundtrip statt die ganze Loop)
- Soll syncHotDoc den Editor "locken" für die ~100ms des Server-Roundtrips?
- Was wenn ein Hot Doc local-only ist (nicht auf dem Server)?

---

## Gelöste Bugs (v0.2.8–v0.2.10)

**Ghost-Pushes bei Cache-Migration (v0.2.8):** `text_matches()` Check vor `sync_from_disk` + Push. Bei Hash-Mismatch aber CRDT-Match wird nur der Hash aktualisiert, kein Push.

**Concurrent-Sync Datenverlust (v0.2.8):** Root Cause waren Ghost-Pushes die neue VV-Einträge erzeugten → korrumpierter Merge bei concurrent initialSync.

**"Text verschwindet" — teilweise gefixt (v0.2.9–v0.2.10):**
- v0.2.9: Editor-Buffer statt vault.read(), Push-Deferral, reconcileOpenEditors
- v0.2.10: Conflict Detection überspringt Live-Typing, writeToVault Guard entfernt
- Ergebnis: Kein Datenverlust mehr, aber "verschluckt" sich (Keystrokes gehen verloren, Sync bricht ab)

---

## Priorität 2 — Code Quality

### sync-engine.ts (~800 Zeilen)
Größte Datei. Wurde durch die Bug-Fixes komplexer. Refactoring-Kandidaten:
- `syncOverlappingDoc` hat zu viele Verantwortungen (conflict detection, merge, push, editor-write)
- Download-Phase als eigene Methode extrahieren
- initialSync in Phasen-Methoden aufteilen

### Generell
LLM-freundlicher Code-Stil: ausgewogene Dateigröße, keine Magie, klare Strukturen.

---

## Priorität 3 — Server-seitiges Orphan-Monitoring

Docs die kein Client mehr referenziert bleiben auf dem Server. Admin-Endpoint oder Logging für "docs not updated in >90 days".

---

## Architektur-Überblick

### Plugin
```
main.ts               — Plugin-Lifecycle, Settings, StatusBar, Onboarding
settings.ts            — VaultCRDTSettings Interface, SettingsTab UI
sync-engine.ts         — WebSocket, Auth, initialSync (Content-Hash Skip), Broadcasts
  └─ syncOverlappingDoc()  — Conflict-Detection + Merge für einzelnes Doc
  └─ reconcileOpenEditors() — Post-initialSync: synct Editor-Divergenz
push-handler.ts        — Outbound-Changes (debounced, deferred during initialSync)
editor-integration.ts  — Editor lesen/schreiben, surgical diffs via TextDelta
document-manager.ts    — CRDT-Doc Cache + .loro Persistenz + VV-Cache Proxy
state-storage.ts       — .loro File I/O, VV-Cache v3 (contentHash), Orphan-Cleanup
conflict-utils.ts      — vvCovers, vvEquals, hasSharedHistory, conflictPath, fnv1aHash
promise-manager.ts     — WS Request/Response Pairing (60s Timeout)
onboarding-modal.ts    — Erster-Start Modal (Pull/Push/Merge)
file-watcher.ts        — External-Change-Detection (focus event)
wasm-bridge.ts         — WASM init + createDocument wrapper
logger.ts              — log/warn/error mit Prefix
```

### Server
```
src/main.rs       — Server-Setup, Background-Tasks (Tombstone/Peer-Expiry, DB-Maintenance)
src/lib.rs        — AppState, DocLocks, Router-Setup
src/ws.rs         — WebSocket Handler, Message-Types (ClientMsg/ServerMsg)
src/handlers.rs   — Message Processing (SyncStart/SyncPush/DocCreate/DocDelete)
src/db.rs         — SQLite Queries (CRUD, Stats, Expiry)
src/vv_serde.rs   — VV Encoding: JSON (wire) ↔ Binary (DB) ↔ Loro VersionVector
src/auth.rs       — JWT Token Generation + Verification
src/errors.rs     — ServerError enum
```

### WebSocket-Protokoll (MessagePack)
Heartbeat: Ping alle 30s → Pong vom Server

**Inbound:** `doc_list`, `sync_delta`, `doc_unknown`, `delta_broadcast`, `doc_deleted`, `ack`, `pong`, `error`
**Outbound:** `ping`, `request_doc_list`, `sync_start`, `sync_push`, `doc_create`, `doc_delete`

### WASM API (WasmSyncDocument)
```
sync_from_disk(text)           — REPLACE: macht CRDT-Text = text (erzeugt Insert/Delete-Ops)
text_matches(text)             — CHECK: CRDT-Text === text? (ohne JS-String Allokation)
import_snapshot(data)          — IMPORT: Snapshot oder Delta importieren
import_and_diff(data)          — IMPORT + DIFF: importiert und gibt TextDelta-JSON zurück
export_delta_since_vv_json(vv) — EXPORT: Ops seit gegebenem VV
export_snapshot()              — EXPORT: Full Snapshot
export_vv_json()               — VV als JSON-String
get_text()                     — Aktueller CRDT-Text
insert_text(pos, text)         — Einzelne Insert-Op
delete_text(pos, len)          — Einzelne Delete-Op
version()                      — Aktuelle Version (f64)
```

**Kritisch:** `sync_from_disk` ist ein REPLACE, kein MERGE. Es erzeugt Ops die den CRDT-Text zum Argument transformieren. Wenn der CRDT nach `import_snapshot` Server-Änderungen hat und man `sync_from_disk(editorContent)` aufruft, erzeugt das DELETE-Ops für die Server-Änderungen. Deswegen muss `sync_from_disk` IMMER VOR `import_snapshot` aufgerufen werden, nie danach.

### Sync-Flow (initialSync v0.2.10)
```
1. Build local file index (metadata only)
2. request_doc_list → Server-VVs (JSON) + Tombstones
3. Load VV-Cache v3 (vv-cache.json mit contentHash)
4. Server-only docs → parallel download (max 5)
5. Overlapping docs:
   - readCurrentContent() || vault.read() + fnv1aHash()
   - Tier 1: VV + hash match → SKIP (no CRDT load)
   - VV match + hash mismatch → offline edit push (CRDT load + sync_push)
   - Tier 2: VV mismatch/no cache → syncOverlappingDoc(isLiveEdit)
     - isLiveEdit=true: skip conflict detection, let CRDT merge handle
     - isLiveEdit=false: conflict detection + conflict file creation
6. Local-only docs → lazy read + push doc_create
7. Flush offline deletes
8. Trash tombstoned files
9. Save VV-Cache v3 (with content hashes)
10. Clean orphaned .loro files
11. reconcileOpenEditors (BEFORE initialSyncRunning=false)
12. Process queued broadcasts
```

---

## Erkenntnisse

- **mtime auf Android instabil**: Obsidian Mobile ändert mtime beim App-Start. Niemals mtime für Caching verwenden.
- **27s client-seitig** für 800× vault.read + 800× getOrLoad (gemessen Session 11:24).
- **Ghost-Pushes verursachen CRDT-Korruption**: Leere Deltas (22b Loro-Framing) erzeugen neue VV-Einträge.
- **vault.read() ist stale wenn Editor offen**: Editor-Buffer kann frische Edits enthalten die noch nicht auf Disk sind.
- **pushFileDelta interleaved mit initialSync**: Beide mutieren dasselbe CRDT-Objekt zwischen await-Points.
- **sync_from_disk ist REPLACE, nicht MERGE**: Darf nie nach import_snapshot aufgerufen werden wenn der Editor die Server-Änderungen nicht hat.
- **Conflict Detection behandelt Live-Typing als externen Edit**: isLiveEdit-Flag in v0.2.10 verhindert das.
- **writeToVault(merged) überschreibt Keystrokes**: Zwischen Capture und Write kann der User tippen. Surgical diffs (import_and_diff + applyDiffToEditor) sind die bessere Lösung.

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy Server: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
- Server-Logs: `ssh home "docker logs vaultcrdt 2>&1 | tail -50"`
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
