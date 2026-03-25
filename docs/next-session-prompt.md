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

## Was letzte Session gebaut wurde

### Plugin v0.2.7
- **Content-Hash statt mtime**: Tier 1 nutzt jetzt FNV-1a Content-Hash statt mtime/size. Grund: mtime ist auf Android nicht stabil zwischen App-Neustarts → Tier 1 griff nie. Content-Hash ist deterministisch.
- **Eliminiert CRDT-Loads**: Bei VV-Match + Hash-Match wird kein `.loro`-File geladen (kein `getOrLoad`). 800 Docs × (vault.read + hash) statt 800 × (vault.read + getOrLoad + text_matches).
- **VV-Cache v3 Format**: `{ vv, contentHash }` statt `{ vv, mtime, size }`. Migriert v1/v2 automatisch.

### Plugin v0.2.6
- **Lazy Content-Reads**: `localContents` wird nicht mehr upfront für alle Docs gelesen. Fixt den **"Text verschwindet"-Bug**.
- **CI-Fix**: Mock-Adapter in Tests um `read`/`write` erweitert.

### Plugin v0.2.5
- **VV-basierter Quick-Check beim initialSync**: Server-VVs aus `doc_list` werden mit lokal gecachten VVs verglichen. Bei 800 Docs und "nichts geändert" von ~800 Roundtrips auf 0.
- **VV-Cache**, **Offline-Edit Push**, **Orphan State Cleanup**, **syncOverlappingDoc()** Extraktion, `vvEquals()`.

### Server v0.2.3
- **VV-Format-Fix**: `doc_list` liefert jetzt JSON-VVs (statt Loro-Binary).
- **DB-Maintenance**: Wöchentlicher Background-Task mit `PRAGMA optimize` + `VACUUM`.
- **Peer-Cleanup**: Peers die >90 Tage nicht connected haben werden stündlich gelöscht.

## Priorität 1 — Mobile Startup testen (v0.2.7)

Content-Hash Fast-Path sollte den Mobile-Startup bei "nichts geändert" deutlich beschleunigen. Erster Start nach Upgrade ist langsam (Cache-Migration), danach sollte es schnell sein.

**Bekanntes Problem (v0.2.6):** mtime ist auf Android nicht stabil zwischen App-Restarts → Tier 1 mit mtime/size griff nie. Deshalb jetzt Content-Hash (FNV-1a).

**Verbleibendes Performance-Budget:**
- 800× `vault.read()` + 800× `fnv1aHash()` — das ist das Minimum für den "nichts geändert"-Fall
- Falls das immer noch zu langsam ist: `vault.read()` parallelisieren oder file-size als Pre-Filter nutzen

**"Text verschwindet"-Bug:** Lazy reads (v0.2.6) sollten das fixen. Falls der Bug weiterhin auftritt: prüfen ob `writeToVault` während initialSync aufgerufen wird (sollte bei Tier 1 skip nicht passieren).

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

### Sync-Flow (initialSync mit Content-Hash Skip)
```
1. Build local file index (metadata only — no content reads)
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

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
