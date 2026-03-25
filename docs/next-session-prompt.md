# Next Session — VaultCRDT Stand 2026-03-25

## Repos & Versionen

| Repo | Version | Pfad |
|------|---------|------|
| Plugin | v0.2.5 | `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin) |
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

### Plugin v0.2.5
- **VV-basierter Quick-Check beim initialSync**: Server-VVs aus `doc_list` werden mit lokal gecachten VVs verglichen. Docs wo Server-VV unverändert + kein lokaler Edit → komplett übersprungen (kein WS-Roundtrip). Bei 800 Docs und "nichts geändert" von ~800 Roundtrips auf 0.
- **VV-Cache**: `lastServerVV` wird nach jedem initialSync als `vv-cache.json` persistiert.
- **Offline-Edit Push**: Wenn Server-VV gleich aber lokal editiert → direkter Push ohne `requestSyncStart`.
- **Orphan State Cleanup**: Nach initialSync werden `.loro`-Dateien gelöscht, die keinem aktiven Doc zugeordnet sind. Räumt alte Encoding-Relikte und gelöschte/umbenannte Docs auf.
- **syncOverlappingDoc()** als separate Methode extrahiert.
- Neue Hilfsfunktion `vvEquals()` in conflict-utils.ts.

### Server v0.2.3
- **VV-Format-Fix**: `doc_list` liefert jetzt JSON-VVs (statt Loro-Binary). Vorher war der VV-Quick-Check auf Client-Seite wirkungslos, weil `doc_list` und `sync_delta` verschiedene VV-Formate lieferten.
- **DB-Maintenance**: Wöchentlicher Background-Task mit `PRAGMA optimize` + `VACUUM`.
- **Peer-Cleanup**: Peers die >90 Tage nicht connected haben werden stündlich gelöscht.

## Priorität 1 — Mobile Startup blockiert 8-10s

### Symptom
Beim Start der Mobile App (Android) zeigt sich ein Spinner für 8-10 Sekunden. Während dieser Zeit ist der Vault benutzbar (man kann tippen), aber:
- Edits während initialSync werden nicht sofort gesynced
- Der getippte Text **verschwindet kurz** und taucht nach ~10s wieder auf
- Erst danach wird der Edit zum Laptop gesynced

### Ursache (Analyse)
Der initialSync blockiert den Sync-Lifecycle:
1. `ws.onopen` → `onInitialSync` callback → `handleInitialSync()` (main.ts:103)
2. `initialSync()` läuft durch alle Phasen (capture local files, request doc_list, download/merge/push)
3. Broadcasts die während initialSync einkommen werden in `queuedBroadcasts` geparkt (sync-engine.ts:513-515)
4. Lokale Edits via `editor-change` werden an `pushHandler.onFileChanged()` weitergeleitet — aber der Push geht nur durch wenn `ws.readyState === WebSocket.OPEN`, was zwar true ist, aber der `sync_push` kann mit dem laufenden initialSync kollidieren

Das "Text verschwindet" passiert wahrscheinlich so:
- User tippt → Editor hat neuen Text
- initialSync merkt: overlapping doc, localContent (snapshot von vor dem Edit) ≠ serverContent → schreibt Server-Version zurück (`writeToVault`)
- User-Edit ist weg (lokaler State wurde überschrieben)
- Nach initialSync: queued edits werden verarbeitet, Text taucht wieder auf

### Lösungsideen
1. **initialSync non-blocking machen**: Sync im Hintergrund, UI sofort freigeben. Aber: Race-Conditions zwischen Edits und Sync müssen gelöst werden.
2. **VV-Quick-Check zuerst, Full-Sync nur für geänderte Docs**: Das haben wir schon gebaut — wenn der VV-Cache stimmt, sollte der Start bei "nichts geändert" quasi instant sein. **ABER:** Der allererste Start nach dem Fix braucht noch einen Full-Sync (alter VV-Cache enthält Binary-Strings statt JSON). Ab dem zweiten Start sollte es schnell sein.
3. **Editor-Lock während initialSync**: Edits während Sync verbieten (schlechte UX, aber sicher).
4. **Snapshot-Zeitpunkt verschieben**: `localContents` nicht am Anfang capturen sondern lazy pro Doc — dann enthält der Snapshot den aktuellen Editor-Stand inkl. Edits.

**Empfehlung**: Erstmal testen ob der VV-Quick-Check nach dem Fix (Server liefert jetzt JSON-VVs) den Startup auf dem Handy tatsächlich beschleunigt. Wenn der Cache korrekt greift, sollte der Spinner verschwinden. Falls nicht: Option 4 (lazy capture) als nächster Schritt.

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

### Sync-Flow (initialSync mit VV-Quick-Check)
```
1. Capture local files + contents (snapshot)
2. request_doc_list → Server-VVs (jetzt JSON!) + Tombstones
3. Load VV-Cache (vv-cache.json)
4. Server-only docs → parallel download (max 5)
5. Overlapping docs:
   a. VV-Match + no local edit → SKIP (kein Roundtrip)
   b. VV-Match + local edit → push delta direkt
   c. VV-Mismatch/no cache → syncOverlappingDoc() (full conflict detection)
6. Local-only docs → push doc_create
7. Flush offline deletes
8. Trash tombstoned files
9. Save VV-Cache
10. Clean orphaned .loro files
11. Process queued broadcasts
```

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
- Plugin an 4 Stellen kopieren: vault-a, vault-b, Dokumente/obsidian-plugins, CloudOrdner/richardsachen
