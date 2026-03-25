# Next Session — VaultCRDT Stand 2026-03-25

## Repos & Versionen

| Repo | Version | Pfad |
|------|---------|------|
| Plugin | v0.2.4 | `/home/richard/projects/vaultcrdt-plugin/` (GitHub: tiny-media/vaultcrdt-plugin) |
| Server | v0.2.2 | `/home/richard/projects/vaultcrdt-server/` (GitHub: tiny-media/vaultcrdt-server) |
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

### Plugin v0.2.3
- `apiKey` → `vaultSecret` umbenannt (intern), inkl. automatischer Migration bei Laden
- Wire-Protocol (`api_key`) zum Server unverändert
- `peer_id` wird jetzt im WebSocket Query-String mitgeschickt

### Server v0.2.2
- Neue DB-Tabelle `peers` (Migration `002_peers.sql`): persistentes Tracking welche Devices mit welchem Vault gesynced haben
- `db::upsert_peer()` beim WS-Connect aufgerufen
- Neuer Endpoint `GET /vault/peers` (JWT-authentifiziert, vault-scoped)

### Plugin v0.2.4
- **Sync-Status-Indicator** in der Statusbar: `sync ●` (verbunden) / `sync ○` (getrennt)
- Toggle in Settings (Sync-Sektion): "Status bar indicator"
- Logik: `●` nur bei echter Server-Antwort (Pong, Ack, Delta) — nicht bei lokalem Send
- 60s ohne Server-Antwort → `○` (fängt WiFi-Verlust nach ~60s ab)
- WS-Close/Error → sofort `○`
- **Synced Devices** in Settings: zeigt alle Devices die je mit diesem Vault gesynced haben + letztes Sync-Datum

## Bekannte Probleme / Nächste Session

### 1. Startup-Scan bei großem Vault (PRIORITÄT HOCH)
**Problem:** Bei `richardsachen` (~800 Docs) scannt der initialSync beim Obsidian-Start alle Dokumente. Das dauert lange und der Vault ist in dieser Zeit nicht benutzbar. Außerdem nervt das Sync-Popup bei jedem Start.

**Gewünschtes Verhalten:** Startup soll schnell und unauffällig sein. Der Sync soll im Hintergrund passieren, ohne den User zu blockieren oder zu nerven. Nur wenn wirklich etwas zu tun ist (neue Docs, Konflikte), soll etwas angezeigt werden.

**Ideen:**
- initialSync nicht blockierend im Hintergrund laufen lassen
- Fortschritts-Notice nur zeigen wenn changed >= N (schon teilweise drin, aber Schwelle prüfen)
- Beim Reconnect nach kurzer Offline-Zeit keinen vollen initialSync, sondern nur Delta seit letztem VV
- VV-basierter Quick-Check: wenn lokale VVs mit Server übereinstimmen, nichts tun

### 2. Offline-Änderungen werden nach Reconnect nicht sofort gepusht
**Problem:** Wenn man offline schreibt und dann wieder online geht, werden die Änderungen erst beim nächsten manuellen Reload (Plugin neu laden) gesynced. Der Reconnect nach WiFi-Rückkehr macht keinen initialSync.

**Fix-Idee:** Nach erfolgreichem Reconnect (WS `onopen`) immer einen leichtgewichtigen Sync machen — nur geänderte Docs pushen, nicht alle 800 neu scannen.

### 3. Status-Indicator: dot-Position
Kleinere CSS-Tweaks nach Bedarf.

## Architektur-Überblick

### Plugin
```
main.ts          — Plugin-Lifecycle, Settings laden, StatusBar
settings.ts      — VaultCRDTSettings Interface, SettingsTab UI
sync-engine.ts   — WebSocket, Auth, initialSync, Message-Handling
push-handler.ts  — Outbound-Changes (debounced), Doc-Create/Delete
editor-integration.ts — Editor lesen/schreiben, surgical diffs
document-manager.ts   — CRDT-Doc Cache + .loro Persistenz
state-storage.ts      — .loro File I/O
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
- Server-Tag für Deploy muss mit compose.yaml übereinstimmen (`v0.2.2`)
