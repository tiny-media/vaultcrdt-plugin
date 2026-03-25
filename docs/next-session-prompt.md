# Next Session — VaultCRDT Stand 2026-03-25

## Repos & Versionen

| Repo | Version | Pfad |
|------|---------|------|
| Plugin | v0.2.7 | `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin) |
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

## Priorität 1 — Mobile Startup Performance

### Status
Die initialSync-Performance wurde in v0.2.5–v0.2.7 schrittweise optimiert:

1. **v0.2.5**: VV-basierter Quick-Check eliminiert WS-Roundtrips (0 statt 800 `sync_start` bei "nichts geändert")
2. **v0.2.6**: Lazy Content-Reads statt Upfront-Capture aller 800 Docs. Fixt den "Text verschwindet"-Bug.
3. **v0.2.7**: Content-Hash (FNV-1a) statt mtime/size (mtime auf Android instabil). Eliminiert CRDT-Loads bei VV+Hash-Match.

### Test-Ergebnis v0.2.7 — ZWEI KRITISCHE BUGS

**Bug 1: 804 Ghost-Pushes bei Cache-Migration**
Beim ersten Start mit v0.2.7 (Cache noch v2 → sentinel `contentHash: 0`) erkennt der Code für JEDES Doc einen "Hash-Mismatch" und ruft den Offline-Edit-Push-Pfad auf:
```
sync_from_disk(localContent) → export_delta_since_vv_json() → sync_push
```
Ergebnis: 804× `sync_push` mit `delta=22b` (leere Deltas, weil CRDT bereits matcht). Das blockiert den Sync für ~16s und bombardiert den Server.

**Root Cause in sync-engine.ts (Overlapping-Loop, VV match + hash mismatch path):**
```typescript
// Dieser Pfad wird bei sentinel contentHash=0 für JEDES Doc betreten:
const doc = await this.docs.getOrLoad(file.path);  // 800× CRDT load!
if (doc.version() > 0 && localContent.trim() !== '') {
  doc.sync_from_disk(localContent);   // no-op wenn CRDT = disk
  const delta = doc.export_delta_since_vv_json(currentServerVV);
  if (delta.length > 0) {  // 22b = Loro framing, kein echtes Delta
    this.send({ type: 'sync_push', ... });  // Ghost-Push!
  }
}
```

**Fix-Idee:** Bei Hash-Mismatch erst `text_matches()` prüfen bevor `sync_from_disk` + Push. Oder: leere Deltas (≤ Schwellenwert, z.B. 32b) nicht pushen.

**Bug 2: "Plan für Mittwoch" wurde leer — Datenverlust**
Timeline aus Server-Logs:
1. `11:46:53` — Mobile verbindet (initialSync mit 804 Ghost-Pushes)
2. `11:47:01` — Laptop verbindet gleichzeitig (eigener initialSync)
3. `11:47:03` — Laptop: `sync_start` für "Plan für Mittwoch" (delta=353b)
4. `11:47:23` — Laptop: `sync_push` für "Plan für Mittwoch" (delta=22b, snapshot=1770b)
5. `11:47:23` — Laptop: `sync_start` (nochmal!) → bekommt delta=228b
6. `11:47:29-33` — Laptop: 4× `sync_push` (User tippt, Snapshots wachsen: 1856→1961)
7. `11:47:57` — Mobile verbindet erneut (2. Start)
8. `11:48:13` — Mobile: 3× `sync_push` für "Plan für Mittwoch" (Snapshot: 1967→2064→**2059** ← SHRINK!)
9. `11:48:25` — Mobile: `sync_push` (2120) + `sync_start` (delta=227b)

**Das Snapshot-Shrink von 2064→2059 zeigt wo Content verloren ging.** Beide Devices schicken Deltas für dasselbe Doc während ihre initialSyncs gleichzeitig laufen → CRDT-Merge konvergiert zu unerwarteter (leerer?) State.

**Hypothese:** Das Ghost-Push (22b Delta) von Mobile hat den Server-CRDT-State korrumpiert. Dann hat der Laptop den korrumpierten State gemerged, und beim nächsten Roundtrip wurde der leere Content zum "Gewinner" des CRDT-Merges.

**Analyse-Plan für nächste Session:**
1. Ghost-Push-Bug fixen (sofort, bevor weitere Tests)
2. Den 22b-Delta auf dem Server inspizieren — was enthält er? `import_snapshot` Ergebnis prüfen
3. Race-Condition analysieren: Was passiert wenn 2 Devices gleichzeitig initialSync machen?
4. Ggf. `initialSync` als exklusiv markieren (Server-Lock pro Doc während Sync)

### "Text verschwindet"-Bug (weiterhin vorhanden)
Der Bug tritt weiterhin auf trotz lazy reads (v0.2.6). Mögliche Ursache: nicht der upfront-Capture, sondern `writeToVault` in `syncOverlappingDoc` (Tier 2/3) überschreibt den Editor-Buffer während der User tippt. Das lazy-Read captured zwar den aktuellen Stand, aber zwischen Read und WriteToVault kann der User weiter tippen → Edit geht verloren.

### Performance
Der Content-Hash Fast-Path konnte noch nicht verifiziert werden, weil Bug 1 (Ghost-Pushes) den ersten Start dominiert hat. Nach dem Fix sollte der zweite Start schnell sein — aber zuerst Bug 1 fixen.

## Priorität 2 — Ghost-Push-Bug + Concurrent-Sync Race

Bevor weitere Performance-Tests: Ghost-Push-Bug (Bug 1) fixen. Dann concurrent-initialSync Race-Condition (Bug 2) untersuchen.

## Priorität 3 — Code Quality

### sync-engine.ts (~795 Zeilen)
Größte Datei. `syncOverlappingDoc()` wurde bereits extrahiert. Weitere Kandidaten:
- Download-Phase (Zeile ~248-302) als eigene Methode
- Die gesamte initialSync-Methode ist ~250 Zeilen lang — könnte in Phasen-Methoden aufgeteilt werden

### state-storage.ts (~191 Zeilen)
Hat 3 Verantwortungen: `.loro` Persistenz, VV-Cache (v3), Orphan-Cleanup. Noch übersichtlich, aber bei weiterem Wachstum VV-Cache in eigene Klasse auslagern.

### conflict-utils.ts (~64 Zeilen)
Enthält jetzt `vvCovers`, `vvEquals`, `hasSharedHistory`, `conflictPath`, `fnv1aHash`. Gut — reine Funktionen, kein State.

### Server
`handlers.rs` ist clean. `db.rs` wächst — prüfen ob `list_docs_with_vv` performant genug für große Vaults ist.

### Generell
LLM-freundlicher Code-Stil: ausgewogene Dateigröße, keine Magie, klare Strukturen.

## Priorität 4 — Server-seitiges Orphan-Monitoring

Docs die kein Client mehr referenziert bleiben auf dem Server. Kein automatisches Löschen (zu gefährlich), aber ein Admin-Endpoint oder Logging für "docs not updated in >90 days" wäre nützlich für manuelles Aufräumen.

## Architektur-Überblick

### Plugin
```
main.ts               — Plugin-Lifecycle, Settings, StatusBar, Onboarding
settings.ts            — VaultCRDTSettings Interface, SettingsTab UI
sync-engine.ts         — WebSocket, Auth, initialSync (Content-Hash Skip), Broadcasts
  └─ syncOverlappingDoc()  — Conflict-Detection + Merge für einzelnes Doc
push-handler.ts        — Outbound-Changes (debounced), Doc-Create/Delete/Rename
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

### Sync-Flow (initialSync v0.2.7)
```
1. Build local file index (metadata only)
2. request_doc_list → Server-VVs (JSON) + Tombstones
3. Load VV-Cache v3 (vv-cache.json mit contentHash)
4. Server-only docs → parallel download (max 5)
5. Overlapping docs:
   - vault.read() + fnv1aHash()
   - Tier 1: VV + hash match → SKIP (no CRDT load)
   - VV match + hash mismatch → offline edit push (CRDT load + sync_push)
   - Tier 2: VV mismatch/no cache → syncOverlappingDoc() (full sync)
6. Local-only docs → lazy read + push doc_create
7. Flush offline deletes
8. Trash tombstoned files
9. Save VV-Cache v3 (with content hashes)
10. Clean orphaned .loro files
11. Process queued broadcasts
```

## Erkenntnisse aus dieser Session

- **mtime auf Android instabil**: Obsidian Mobile ändert mtime beim App-Start. Niemals mtime für Caching verwenden.
- **Server-Logs zeigen 0 sync_starts bei VV-Match**: VV-Quick-Check funktioniert serverseitig. Bottleneck ist client-seitig.
- **27s client-seitig** für 800× vault.read + 800× getOrLoad (gemessen Session 11:24).
- **Cache-Migration erzeugt Ghost-Pushes**: Sentinel-Werte (contentHash: 0) triggern den Offline-Edit-Push für JEDES Doc. 804× sync_push mit 22b Deltas.
- **Concurrent initialSync = Datenverlust**: Wenn Mobile und Laptop gleichzeitig initialSync machen und Ghost-Pushes senden, konvergiert der CRDT zu unerwartetem State. "Plan für Mittwoch" wurde leer.

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy Server: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
- Server-Logs: `ssh home "docker logs vaultcrdt 2>&1 | tail -50"`
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
