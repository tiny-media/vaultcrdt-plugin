# Next Session — VaultCRDT Stand 2026-03-25

## Repos & Versionen

| Repo | Version | Pfad |
|------|---------|------|
| Plugin | v0.2.6 | `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin) |
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

## Was letzte Session gebaut wurde

### Plugin v0.2.6
- **Metadata-Fast-Path (Tier 1)**: VV-Cache speichert jetzt `mtime` + `size` pro Doc. Bei VV-Match + unverändertem mtime/size wird das Doc komplett ohne Disk-I/O geskippt. Bei 800 Docs und "nichts geändert": von ~14s auf <100ms (nur in-memory stat-Vergleiche).
- **Lazy Content-Reads**: `localContents` wird nicht mehr upfront für alle Docs gelesen, sondern erst wenn Tier 2/3 es tatsächlich braucht. Fixt den **"Text verschwindet"-Bug** (User-Edits während initialSync wurden vorher durch stale Snapshot überschrieben).
- **3-Tier Skip-Logik**: Tier 1 (VV+mtime+size) → Tier 2 (VV+CRDT+text_matches) → Tier 3 (Full Sync).
- **VV-Cache v2 Format**: Backward-kompatibel — alte v1 Caches werden automatisch migriert (Sentinel-Werte für mtime/size).
- **CI-Fix**: Mock-Adapter in Tests um `read`/`write` erweitert.

### Plugin v0.2.5
- **VV-basierter Quick-Check beim initialSync**: Server-VVs aus `doc_list` werden mit lokal gecachten VVs verglichen. Bei 800 Docs und "nichts geändert" von ~800 Roundtrips auf 0.
- **VV-Cache**, **Offline-Edit Push**, **Orphan State Cleanup**, **syncOverlappingDoc()** Extraktion, `vvEquals()`.

### Server v0.2.3
- **VV-Format-Fix**: `doc_list` liefert jetzt JSON-VVs (statt Loro-Binary).
- **DB-Maintenance**: Wöchentlicher Background-Task mit `PRAGMA optimize` + `VACUUM`.
- **Peer-Cleanup**: Peers die >90 Tage nicht connected haben werden stündlich gelöscht.

## Priorität 1 — Mobile Startup testen (v0.2.6)

Der Metadata-Fast-Path (Tier 1) sollte den Mobile-Startup bei "nichts geändert" auf <1s bringen. **Wichtig**: Der erste Start nach dem Upgrade ist einmalig langsam (alter VV-Cache hat kein mtime/size → Sentinel-Werte → alle Docs gehen durch Tier 2/3). Ab dem zweiten Start greift Tier 1.

**Test-Prozedur:**
1. Plugin auf Handy deployen
2. App starten → warten bis Sync fertig (erster Start = langsam, Cache wird im neuen Format geschrieben)
3. App komplett schließen
4. Nochmal starten → sollte jetzt <1s sein
5. Console Logs prüfen: `skippedVVMatch` sollte ~800 zeigen

Falls der zweite Start immer noch langsam ist: Logs prüfen ob Tier 1 tatsächlich matcht (mtime/size-Vergleich).

## Priorität 2 — Docs & Code Quality

### Docs aufräumen
- `next-session-prompt.md` enthält mittlerweile viel historischen Ballast aus früheren Sessions. Komprimieren: nur aktuelle Architektur + offene Probleme behalten, alte "was wurde gebaut"-Abschnitte entfernen.
- README.md für beide Repos prüfen/aktualisieren.

### Code Quality Checks
- `sync-engine.ts` ist mit ~725 Zeilen die größte Datei. Die Extraktion von `syncOverlappingDoc()` war ein guter Schritt. Prüfen ob weitere Extraktionen sinnvoll sind (z.B. die Download-Phase als eigene Methode).
- `state-storage.ts` hat jetzt 3 Verantwortungen (`.loro` Persistenz, VV-Cache, Orphan-Cleanup). Prüfen ob das noch übersichtlich genug ist oder ob der VV-Cache + Cleanup in eine eigene Klasse sollte.
- Server: `handlers.rs` ist clean. `db.rs` wächst — prüfen ob die neue `list_docs_with_vv` Konvertierung performant genug ist für große Vaults.
- Generell: LLM-freundlicher Code-Stil (ausgewogene Dateigröße, keine Magie, klare Strukturen).

## Priorität 3 — Server-seitiges Orphan-Monitoring

Docs die kein Client mehr referenziert bleiben auf dem Server. Kein automatisches Löschen (zu gefährlich), aber ein Admin-Endpoint oder Logging für "docs not updated in >90 days" wäre nützlich für manuelles Aufräumen.

## Architektur-Überblick

### Plugin
```
main.ts               — Plugin-Lifecycle, Settings, StatusBar, Onboarding
settings.ts            — VaultCRDTSettings Interface, SettingsTab UI
sync-engine.ts         — WebSocket, Auth, initialSync (VV-Quick-Check), Broadcasts
  └─ syncOverlappingDoc()  — Conflict-Detection + Merge für einzelnes Doc
push-handler.ts        — Outbound-Changes (debounced), Doc-Create/Delete/Rename
editor-integration.ts  — Editor lesen/schreiben, surgical diffs via TextDelta
document-manager.ts    — CRDT-Doc Cache + .loro Persistenz + VV-Cache Proxy
state-storage.ts       — .loro File I/O, VV-Cache (vv-cache.json), Orphan-Cleanup
conflict-utils.ts      — vvCovers, vvEquals, hasSharedHistory, conflictPath
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

### Sync-Flow (initialSync mit 3-Tier Skip)
```
1. Build local file index (metadata only — no content reads)
2. request_doc_list → Server-VVs (JSON) + Tombstones
3. Load VV-Cache v2 (vv-cache.json mit mtime/size)
4. Server-only docs → parallel download (max 5)
5. Overlapping docs (3-Tier):
   Tier 1: VV + mtime + size match → SKIP (zero I/O)
   Tier 2: VV match, metadata changed → lazy read + CRDT check
   Tier 3: VV mismatch/no cache → syncOverlappingDoc() (full sync)
6. Local-only docs → lazy read + push doc_create
7. Flush offline deletes
8. Trash tombstoned files
9. Save VV-Cache v2 (with current mtime/size)
10. Clean orphaned .loro files
11. Process queued broadcasts
```

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
