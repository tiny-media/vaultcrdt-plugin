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

## Was diese Session gebaut wurde

### Plugin v0.2.5
- **VV-basierter Quick-Check beim initialSync**: Server-VVs aus `doc_list` werden mit lokal gecachten VVs verglichen. Docs wo Server-VV unverändert + kein lokaler Edit → komplett übersprungen (kein WS-Roundtrip). Bei 800 Docs und "nichts geändert" von ~800 Roundtrips auf 0.
- **VV-Cache**: `lastServerVV` wird nach jedem initialSync als `vv-cache.json` persistiert. Beim nächsten Start sofort verfügbar.
- **Offline-Edit Push**: Wenn Server-VV gleich aber lokal editiert → direkter Push ohne `requestSyncStart`.
- **Orphan State Cleanup**: Nach initialSync werden `.loro`-Dateien gelöscht, die keinem aktiven Doc (lokal oder Server) zugeordnet sind. Räumt alte Encoding-Relikte (`_` statt `__`) und gelöschte/umbenannte Docs auf.
- **syncOverlappingDoc()** als separate Methode extrahiert (aus der initialSync-Schleife).
- Neue Hilfsfunktion `vvEquals()` in conflict-utils.ts.

### Server v0.2.3
- **DB-Maintenance**: Wöchentlicher Background-Task mit `PRAGMA optimize` + `VACUUM`.
- **Peer-Cleanup**: Peers die >90 Tage nicht connected haben werden stündlich gelöscht.

## Bekannte Probleme / Nächste Session

### 1. Status-Indicator: dot-Position
Kleinere CSS-Tweaks nach Bedarf.

### 2. Server-seitiges Orphan-Monitoring
Docs die kein Client mehr referenziert bleiben auf dem Server. Aktuell kein automatisches Löschen (zu gefährlich), aber ein Admin-Endpoint oder Logging für "stale docs" wäre nützlich.

### 3. Encoding-Migration (richardsachen)
Die 699 `.loro`-Files mit altem `_`-Encoding werden beim nächsten Start als Orphans gelöscht. Die Docs werden über den Server neu gesynced (Full-Sync weil kein VV-Cache). Einmaliger langsamer Start, danach schnell.

## Architektur-Überblick

### Plugin
```
main.ts          — Plugin-Lifecycle, Settings laden, StatusBar
settings.ts      — VaultCRDTSettings Interface, SettingsTab UI
sync-engine.ts   — WebSocket, Auth, initialSync (VV-Quick-Check), Message-Handling
push-handler.ts  — Outbound-Changes (debounced), Doc-Create/Delete
editor-integration.ts — Editor lesen/schreiben, surgical diffs
document-manager.ts   — CRDT-Doc Cache + .loro Persistenz
state-storage.ts      — .loro File I/O, VV-Cache, Orphan-Cleanup
conflict-utils.ts     — VV-Vergleich (vvCovers, vvEquals, hasSharedHistory)
promise-manager.ts    — WS Request/Response Pairing (mit Timeout)
onboarding-modal.ts   — Erster-Start Modal (Pull/Push/Merge)
```

### Server-Endpoints
| Methode | Pfad | Auth | Zweck |
|---------|------|------|-------|
| POST | `/auth/verify` | — | JWT Token holen |
| GET | `/health` | — | Server-Status |
| GET | `/ws` | JWT (Query) | WebSocket |
| GET | `/vault/peers` | JWT (Bearer) | Synced Devices |
| GET | `/debug/vault-stats` | JWT (Bearer) | Speicher-Stats |
| GET | `/debug/connections` | Admin-Token | Aktive Verbindungen |

### WebSocket-Protokoll (MessagePack)
Heartbeat: Ping alle 30s → Pong vom Server

**Inbound:** `doc_list`, `sync_delta`, `doc_unknown`, `delta_broadcast`, `doc_deleted`, `ack`, `pong`, `error`

**Outbound:** `ping`, `request_doc_list`, `sync_start`, `sync_push`, `doc_create`, `doc_delete`

## SSH / Deploy
- `SSH_AUTH_SOCK` → 1Password Agent (`~/.1password/agent.sock`)
- Deploy: `cd ~/fleet && just home-deploy vaultcrdt`
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.3`)
