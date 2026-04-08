# Dogfooding-Checkliste — v0.2.18

Ziel: manuelles Ende-zu-Ende-Testing nach
- Conflict-Storm-Härtung (`f366dd8`)
- Delete-Ack-Härtung (`aa60d60`)
- SetupModal Admin-Token + Reconfigure (`87a40f4`, v0.2.18)

Setup: Desktop (Vault A ↔ Server `home` v0.2.6) + Android parallel wo
angegeben. Server-DB wurde in Session 10 komplett gewiped (Baseline
177 KB, Target Re-Check 2026-07-08) — Vaults werden über das Plugin
neu angelegt, kein curl mehr nötig.

Legende:
- 🧑 = GUI/manueller Schritt (nur am Gerät prüfbar)
- 🤖 = kann über pi-mono als Remote-Trigger laufen (siehe Sektion 11)

**Sektionen 1–9 sind durchgehend 🧑** (Editor/Filesystem/Netz-Manipulation
am Gerät). Sektion 10 mischt 🧑 + 🤖. Sektion 11 ist reine 🤖-Automatisierung.

---

## 1. Grundfunktion — Online-Edit

- [ ] Datei auf Desktop bearbeiten → Änderung erscheint auf Android (< 5s)
- [ ] Datei auf Android bearbeiten → Änderung erscheint auf Desktop (< 5s)

## 2. Online-Delete

- [ ] WS offen, Datei auf Desktop löschen → auf Android weg (< 5s)
- [ ] WS offen, Datei auf Android löschen → auf Desktop weg (< 5s)
- [ ] Obsidian auf Desktop neu starten → Datei bleibt weg (kein Ghost-Reconnect)

## 3. Offline-Delete

- [ ] WS auf Desktop killen (Plugin deaktivieren oder Netz trennen)
- [ ] Datei löschen während offline
- [ ] WS reconnecten → Datei weg, bleibt weg
- [ ] Dasselbe auf Android: Netz weg, Datei löschen, Netz an → Datei weg

## 4. Kill-während-Commit-Race (Kernfall für `aa60d60`)

- [ ] Delete auf Desktop triggern, WS **sofort** killen (Plugin deaktivieren bevor ACK ankommt)
- [ ] Reconnecten → Datei weg (Server hat Tombstone, Plugin reconciled delete journal)
- [ ] Variante: Delete auf Android, sofort in Flugmodus, zurück → Datei weg

## 5. Rename

- [ ] Datei auf Desktop umbenennen → neuer Name auf Android, alter weg
- [ ] Datei auf Android umbenennen → neuer Name auf Desktop, alter weg
- [ ] Rename während Offline → nach Reconnect konsistent

## 6. Conflict-Fork (aus Zyklus-1-Tests)

- [ ] Beide Seiten gleichzeitig dieselbe Datei bearbeiten (Netz getrennt) → nach Reconnect: eine Version gewinnt, keine Datei verloren
- [ ] Beide Seiten dieselbe Datei löschen → nach Reconnect: weg, kein Fehler

## 7. Mehrere Dateien gleichzeitig

- [ ] 5+ Dateien auf Desktop anlegen → alle erscheinen auf Android
- [ ] 5+ Dateien auf Desktop löschen → alle weg auf Android

## 8. Server-Neustart

- [ ] Server stoppen, auf Desktop weiterarbeiten (Edit + Delete), Server starten → alles synchronisiert sich

## 9. Conflict-Storm-Härtung (Kernfall für `f366dd8`)

### 9a. Stabile PeerID über Restarts

- [ ] Datei auf Desktop anlegen, bearbeiten, Obsidian beenden
- [ ] Obsidian neu starten, dieselbe Datei weiter bearbeiten
- [ ] Datei bleibt sauber (kein doppelter Text, keine Phantom-Inserts durch neue VV-Linie)
- [ ] Dasselbe Szenario 5× hintereinander wiederholen → keine Drift

### 9b. Phase-3 Adopt-Semantik (disjoint VV, gleicher Text)

- [ ] Desktop offline nehmen, Datei minimal bearbeiten (derselbe Text am Ende → Hash gleich)
- [ ] Android dieselbe Datei bearbeiten, sodass am Ende ebenfalls derselbe finale Text steht
- [ ] Beide wieder online bringen → einer der Clients adopted, kein Conflict-File, kein doppelter Text
- [ ] Variante: beide mit echten Text-Differenzen → **ein** Conflict-File mit der verlorenen Seite, Primärdatei behält eine Version

### 9c. Phase-2 Adopt (fehlender lokaler CRDT-State)

- [ ] Auf Desktop `data.json` löschen (Plugin-State weg), Obsidian neu starten
- [ ] Initial-Sync zieht Server-Snapshot **wholesale** (kein Merge-Versuch gegen lokalen Text)
- [ ] Wenn lokaler Text identisch war: kein Conflict-File, genau **ein** `sync_start` mit `client_vv=null`
- [ ] Wenn lokaler Text differs: genau **ein** Conflict-File mit dem lokalen Text

### 9d. Editor-first Content Reads (Kernfall gegen stale disk)

- [ ] Datei in Desktop-Obsidian öffnen, Text eintippen **ohne zu speichern** (Obsidian-Auto-save deaktivieren falls nötig)
- [ ] Während die Änderung im Editor-Buffer hängt: Sync via Disconnect/Reconnect triggern
- [ ] Wenn Konflikt entsteht: Conflict-File-Body enthält **Editor-Text**, nicht den alten Disk-Stand
- [ ] Dasselbe mit Datei in Split-Pane (nicht active leaf): Editor-Text wird ebenfalls bevorzugt

### 9e. Local-only doc_create mit offenem Editor

- [ ] Neue Datei auf Desktop anlegen, sofort tippen **ohne zu speichern**
- [ ] Sync triggern → Server bekommt **Editor-Text**, nicht die (leere) Disk-Version

### 9f. Vault-Klon-Caveat (erwartet bricht!)

- [ ] `data.json` inkl. `peerId` auf ein zweites Gerät kopieren (z.B. via Cloud-Sync)
- [ ] Beide Geräte starten → **erwartet: Konflikte weil PeerID identisch** (ist bekannt, siehe `project_peerid_clone_caveat` Memory)
- [ ] Wenn das passiert: nur dokumentieren, kein Blocker für Release

---

## 10. Setup-Flow (v0.2.18, Kernfall für `87a40f4`)

### 10a. Neuen Vault via Plugin anlegen

- [ ] 🧑 BRAT auf Desktop auf v0.2.18 pullen, Plugin neu laden
- [ ] 🧑 SetupModal öffnet sich automatisch (weil vaultId/Secret nach Wipe leer sind)
- [ ] 🧑 Server-URL + neuer Vault-Name (z.B. `arbeitsnotizen`) + Passwort eintragen
- [ ] 🧑 "Creating a new vault?" aufklappen, Admin-Token aus SOPS einfügen (Token-Quelle: `sops -d ~/fleet/hosts/home/stacks/vaultcrdt/secrets.sops.yaml`)
- [ ] 🧑 Connect klicken → Modal schließt ohne Error, Plugin verbindet (sync ● in Statusbar)
- [ ] 🤖 `/vault/peers` (siehe 11b) zeigt Desktop als neuen Peer
- [ ] 🤖 `/debug/vault-stats` (siehe 11c) zeigt den neuen Vault mit `doc_count > 0` nach dem ersten Push
- [ ] 🧑 Admin-Token wird **nicht** in `data.json` persistiert: `grep -i admin .obsidian/plugins/vaultcrdt/data.json` → kein Treffer
- [ ] 🧑 Android-BRAT auf v0.2.18, Setup mit gleichem Vault-Name + Passwort, **ohne Admin-Token** → Connect funktioniert (existing vault path)

### 10b. Reconfigure zu anderem Vault

- [ ] 🧑 Settings öffnen → "Reconnect to a different vault" → Reconfigure
- [ ] 🧑 Anderen Vault-Namen + Passwort + Admin-Token eintragen → Connect
- [ ] 🧑 Nach Reconnect: sync ● in Statusbar, keine Ghost-Dateien aus dem alten Vault
- [ ] 🧑 Filesystem-Check: `.obsidian/plugins/vaultcrdt/state/*.loro` enthält nur noch Keys zum neuen Vault
- [ ] 🤖 `/debug/vault-stats` zeigt beide Vaults separat, alter Vault bleibt unverändert (kein versehentliches Überschreiben)

### 10c. Reconfigure auf gleichen Vault (State-Erhalt)

- [ ] 🧑 Reconfigure mit **identischem** vaultId, nur Server-URL ändern
- [ ] 🧑 Lokale `.loro` State-Files bleiben erhalten (kein Wipe weil vaultId gleich)
- [ ] 🧑 Nach Reconnect: sync läuft ohne Re-Download

### 10d. 401-Hint-Messaging

- [ ] 🧑 In SetupModal frischen Vault-Namen eintragen **ohne** Admin-Token
- [ ] 🧑 Connect → Modal zeigt "Authentication failed … expand 'Creating a new vault?' and enter the admin token"
- [ ] 🧑 Admin-Token nachtragen, erneut Connect → klappt

---

## 11. Automatisierung via pi-mono (Remote Triggers)

Diese Checks brauchen **keine** GUI und können als scheduled triggers
auf pi-mono laufen. Zweck: kontinuierliches Monitoring zwischen
manuellen Dogfood-Runden; sie ersetzen den Dogfood nicht, sondern
fangen Server-seitige Regressionen frühzeitig ab.

Empfohlene Frequenz in Klammern; konkrete Cron-Strings entstehen beim
Einrichten mit dem pi-mono `schedule` skill.

### 11a. Health-Ping  (15 min)

```bash
curl -fsS https://<server>/health | jq '.version'
```

- Erwarte: HTTP 200, `.version == "0.2.6"`
- Alert-Bedingung: HTTP ≠ 200 oder Version drift
- Context: fleet-Host ist `home`, Stack `vaultcrdt`

### 11b. Auth + Peer-Inventar  (daily)

```bash
TOKEN=$(sops -d ~/fleet/hosts/home/stacks/vaultcrdt/secrets.sops.yaml \
  | awk -F'"' '/VAULTCRDT_ADMIN_TOKEN/{print $4}')
JWT=$(curl -fsS -X POST https://<server>/auth/verify \
  -H 'Content-Type: application/json' \
  -d "{\"vault_id\":\"<vault>\",\"api_key\":\"<pw>\"}" | jq -r .token)
curl -fsS https://<server>/vault/peers -H "Authorization: Bearer $JWT" | jq .
```

- Erwarte: JWT ≠ null; `peers[]` enthält Desktop + Android
- Alert: einer der beiden `last_seen_at` älter als 7 Tage → verdächtig offline
- Der `api_key` für den Dogfood-Vault liegt ebenfalls in SOPS (oder 1Password), **nicht** im Skript hardcoden

### 11c. Baseline-Drift  (daily)

```bash
curl -fsS https://<server>/debug/vault-stats \
  -H "Authorization: Bearer $JWT" | jq '{doc_count, total_snapshot_bytes, total_vv_bytes}'
```

- Baseline aus `project_server_baseline_2026-04-08` Memory:
  DB ~177 KB, `doc_count` klein (wipe), NET-I/O ~0
- Alert: `total_snapshot_bytes` > 500 MB (erwartetes 3-Monats-Wachstum)
  oder DB-Explosion (> 10× Baseline) in < 24h
- Target Re-Check: **2026-07-08** für 3-Monats-Delta (Memory-Reminder)

### 11d. Server-Log-Scan  (daily)

```bash
ssh home 'docker logs --since 24h vaultcrdt-server 2>&1 \
  | grep -E "\bERROR\b|\bWARN\b|panic|tombstone refused" \
  | grep -v "known-noise-pattern"'
```

- Erwarte: leere Ausgabe
- Alert: jede Zeile → Incident-Trigger
- Noise-Filter kuratieren, damit echte Regressionen nicht in Rauschen untergehen

### 11e. Release-Readiness (on tag push)

Wenn ein `v*` Tag auf `vaultcrdt-plugin` oder `vaultcrdt-server` landet:

- Plugin: GitHub-Release muss binnen 10 min erscheinen (Release-Workflow grün), `main.js` + `manifest.json` + `wasm/` als Assets
- Server: Release-Workflow grün, Docker-Image-Tag `ghcr.io/tiny-media/vaultcrdt-server:<version>` pullbar
- Alert: Workflow rot oder Asset fehlt

### Was explizit NICHT automatisiert wird

- Alles mit 🧑 in Sektionen 1–10 (Conflict-Fork, Editor-first, Delete-Races, Rename, Vault-Klon-Caveat) — braucht echte Obsidian-Instanzen auf Desktop+Android
- Android-Flugmodus-Szenarien
- Visuelle Conflict-File-Inspektion

Das manuelle Dogfood bleibt **vor jedem Release** Pflicht. Die
Automatisierung fängt nur Drift zwischen den Runden ab.

---

## Ergebnis

Datum: ___________
Desktop-Version: 0.2.18
Android-Version: 0.2.18
Server-Version: 0.2.6

- [ ] Alle Checks grün → bereit für weitere Nutzung
- [ ] Gefundene Issues → unten notieren

### Issues

_keine_
