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

### Offener Test (v0.2.7)
**Ergebnis steht aus**: User testet gerade ob der Content-Hash Fast-Path den Mobile-Startup beschleunigt. Erster Start nach Upgrade ist einmalig langsam (Cache-Migration v2→v3).

**Was bei "nichts geändert" passiert:**
- 800× `vault.read()` + 800× `fnv1aHash()` (schnell, ~32bit hash)
- Bei VV+Hash-Match: kein `getOrLoad()`, kein `.loro`-Load, kein WASM-Import → SKIP

**Falls immer noch langsam:**
- Server-Logs prüfen: `sync_start`-Count in der Session (sollte 0 sein)
- Client-Logs prüfen: `skippedVVMatch` sollte ~800 sein
- Nächste Optionen: `vault.read()` parallelisieren, file-size Pre-Filter, oder Batch-Read API

### "Text verschwindet"-Bug
Vor v0.2.6 wurde `localContents` upfront gecaptured. Wenn der User während initialSync tippt, wurde sein Edit durch den stale Snapshot überschrieben. Ab v0.2.6 werden Contents lazy gelesen → Snapshot enthält aktuelle Edits. **Verifizieren ob der Bug mit v0.2.7 weg ist.**

## Priorität 2 — Code Quality

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

## Priorität 3 — Server-seitiges Orphan-Monitoring

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

- **mtime auf Android instabil**: Obsidian Mobile ändert mtime beim App-Start. Niemals mtime für Caching verwenden. Content-Hash oder size sind zuverlässig.
- **Server-Logs zeigen 0 sync_starts**: Der VV-Quick-Check (v0.2.5) funktioniert serverseitig. Das Bottleneck war rein client-seitig (800× CRDT-Load).
- **27s zwischen doc_list und erstem sync_start**: Gemessen in Server-Logs (Session 11:24). Das war die Zeit für 800× vault.read + 800× getOrLoad im alten Code.

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy Server: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
- Server-Logs: `ssh home "docker logs vaultcrdt 2>&1 | tail -50"`
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
