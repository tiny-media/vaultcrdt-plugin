# Audit: Friend-Handoff-Readiness VaultCRDT

## 1. Executive Summary

**Bedingt sicher fuer einen trusted friend handoff, aber nicht als “einfach README schicken und los” freigeben.**

Keine P0-Blocker gefunden. Die Kernsignale sind gut: Plugin-/Server-Tests gruen, WASM frisch, Server live healthy, zentrale Sync-Hardening-Fixes sind vorhanden.

**Handoff sollte aber blockiert bleiben, bis diese P1-Vorbedingungen erledigt sind:**

1. Backup-/Rollback-Anleitung vor dem ersten Sync.
2. Server-Backup/Restart-Betrieb geklaert.
3. Minimaler realer Smoke-Test auf frischem Vault und Zielgeraeten.
4. Server-URL exakt/normalisiert dokumentieren oder trailing-slash robust machen.
5. Live-Konfliktkopien vom 2026-04-27 im Smoke-Test nachstellen oder als erwartbares Schutzverhalten erklaeren.

## 2. P0/P1/P2 Findings Table

| ID | Severity | Finding | Blockiert Friend-Handoff? |
|---|---:|---|---|
| F1 | P1 | Kein expliziter Backup-/Rollback-Pfad vor erstem Sync | Ja |
| F2 | P1 | Server-Betrieb: Backup/Restore und Restart-Policy nicht handoff-reif dokumentiert | Ja, wenn Freund darauf taeglich nutzt |
| F3 | P1 | Minimaler Realgeraete-Smoke-Test fehlt | Ja |
| F4 | P1 | Server-URL wird nicht normalisiert; trailing slash/path kann Setup brechen | Bedingt |
| F5 | P1 | Live-Logs zeigen unerwartete Conflict-Copies nach Restart | Bedingt, bis Smoke geklaert |
| F6 | P2 | Logs/Observability: viele Loro-INFO-Zeilen und sensible Dateipfade | Nein |
| F7 | P2 | Doku-/Versionsdrift in README/CHANGELOG/Setup-Annahmen | Nein fuer Friend, ja vor public release |
| F8 | P2 | CI/Release prueft WASM-Freshness nicht automatisch | Nein, aktueller Check gruen |
| F9 | P2 | Security-Hinweise fuer private Deployment muessen explizit in Handoff | Nein, wenn bewusst akzeptiert |

## 3. Findings

### F1 — P1 — Kein expliziter Backup-/Rollback-Pfad vor erstem Sync

- **Evidence:** `README.md`, `docs/install-brat.md` beschreiben Installation und Connect, aber keinen Pflicht-Backup-Schritt. `src/sync-initial.ts` schreibt und loescht aktiv lokale Dateien (`editor.writeToVault`, `app.vault.trash` bei Tombstones).
- **Warum relevant:** Der erste Sync kann Dateien anlegen, ueberschreiben, trashen oder Conflict-Copies erzeugen. Ohne vorherige Vault-Kopie ist ein Freund im Fehlerfall unsicher.
- **Naechste Aktion:** Vor Handoff eine kurze Anleitung: Obsidian schliessen, Vault komplett kopieren/zippen, Plugin erst dann aktivieren, Rollback: Plugin deaktivieren, Vault aus Backup ersetzen.
- **Blockiert Handoff:** Ja.

### F2 — P1 — Server-Backup/Restore und Restart-Policy fehlen als Betriebsrunbook

- **Evidence:** `../vaultcrdt-server/README.md` beschreibt Start und Vault-Erstellung, aber kein Backup/Restore. `docker-compose.yml` hat Healthcheck, aber keine `restart: unless-stopped`. Live-Beobachtung: Container healthy, aber nur Momentaufnahme.
- **Warum relevant:** Server-DB-Verlust kann Tombstones/Sync-Historie verlieren und spaeter Resurrection-/Merge-Folgen erzeugen.
- **Naechste Aktion:** Vor Handoff festlegen: Wer hostet, wie wird `data.db` inklusive WAL/SHM oder per SQLite-Backup gesichert, wie wird restore getestet, welche Restart-Policy gilt.
- **Blockiert Handoff:** Ja, wenn der Freund es taeglich nutzt.

### F3 — P1 — Minimaler Realgeraete-Smoke-Test fehlt

- **Evidence:** `next-session-handoff.md` nennt Android-Smoke-Test als naechsten Schritt. Automatisierte Tests sind gruen, aber kein aktueller BRAT-/Obsidian-End-to-End-Nachweis im Audit.
- **Warum relevant:** Die kritischen Fehler waren bisher echte Obsidian-/Android-/Startup-Szenarien, nicht reine Unit-Test-Probleme.
- **Naechste Aktion:** Vor Handoff: frischer Testvault, BRAT-Install, Push vom leeren Server, Pull auf zweitem Geraet, Edit/Delete/Rename/offline reconnect, Server-Restart, Android-Kaltstart ohne und mit sofortigem Tippen.
- **Blockiert Handoff:** Ja.

### F4 — P1 — Server-URL nicht normalisiert

- **Evidence:** `src/url-policy.ts` `toHttpBase()`/`toWsBase()` ersetzen nur Scheme. `src/setup-modal.ts` haengt `${httpBase}/auth/verify` an. `https://sync.example.com/` wird damit zu `https://sync.example.com//auth/verify`.
- **Warum relevant:** Ein Freund kopiert URLs leicht mit trailing slash. Das kann Setup mit 404/generischem Fehler brechen.
- **Naechste Aktion:** Entweder vor Handoff in Anleitung exakt “ohne trailing slash” schreiben oder besser URL beim Speichern normalisieren und testen.
- **Blockiert Handoff:** Bedingt.

### F5 — P1 — Live-Logs zeigen Conflict-Copies nach Restart

- **Evidence:** `live-server-observation.md`: nach Server-Restart am 2026-04-27 wurden `[REDACTED_CONFLICT].md` und `[REDACTED_CONFLICT].md` als neue Docs erstellt.
- **Warum relevant:** Conflict-Copies schuetzen Daten, aber fuer einen Freund wirken sie wie Sync-Fehler. Wenn das bei Restart reproduzierbar ist, ist es ein Handoff-Blocker.
- **Naechste Aktion:** Im Smoke-Test Server-Restart + Reconnect pruefen. Falls Conflict-Copies entstehen: Ursache klaeren. Falls nicht: Handoff erklaert Conflict-Copies als Schutzmechanismus.
- **Blockiert Handoff:** Bedingt.

### F6 — P2 — Logs/Observability noise und Dateipfad-Leakage

- **Evidence:** Live-Logs enthalten viele `loro_internal::... Diagnosing EncodedBlock` INFO-Zeilen und vollstaendige Doc-Pfade.
- **Warum relevant:** Erschwert Monitoring und Dateinamen koennen privat sein.
- **Naechste Aktion:** Logging-Filter dokumentieren oder setzen, z. B. `vaultcrdt_server=info,loro=warn,loro_internal=warn`; Handoff: Logs nicht oeffentlich teilen.
- **Blockiert Handoff:** Nein.

### F7 — P2 — Doku-/Versionsdrift

- **Evidence:** Server `README.md` sagt Status `0.2.4`, `Cargo.toml` ist `0.2.6`. Plugin `CHANGELOG.md` endet bei `0.2.18`, Release ist `0.3.0`. Server README sagt, Plugin erstelle keine Vaults; SetupModal kann per Admin Token neue Vaults registrieren.
- **Warum relevant:** Fuer self-hosting durch einen Freund koennen widerspruechliche Anweisungen Setup-Zeit kosten.
- **Naechste Aktion:** Friend-Handoff-Dokument als aktuelle Single-Page-Anleitung erstellen; spaeter READMEs/CHANGELOG aktualisieren.
- **Blockiert Handoff:** Nein, wenn Handoff-Guide korrekt ist.

### F8 — P2 — CI/Release prueft WASM-Freshness nicht

- **Evidence:** Plugin `.github/workflows/ci.yml` und `release.yml` laufen Test/Typecheck/Build, aber kein `bun run wasm:check`.
- **Warum relevant:** Bei kuenftigen Rust-Crate-Aenderungen koennte stale WASM released werden.
- **Naechste Aktion:** `bun run wasm:check` in CI/Release oder Pre-Release-Checklist aufnehmen.
- **Blockiert Handoff:** Nein; aktueller Audit-Check war gruen.

### F9 — P2 — Security-Hinweise muessen explizit sein

- **Evidence:** Plugin speichert `vaultSecret` in Obsidian plugin data; WS nutzt `?token=...`; README sagt kein E2E, TLS noetig; Server logs enthalten Vault/Doc-Namen.
- **Warum relevant:** Fuer kleine private Deployments akzeptabel, aber der Freund muss wissen: Server sieht Notizen, Geraeteprofil enthaelt Secret, TLS ist Pflicht.
- **Naechste Aktion:** In Handoff kurz auffuehren: starke random Passwords, TLS/WSS, Server-/Log-Zugriff privat, kein E2E.
- **Blockiert Handoff:** Nein, wenn bewusst akzeptiert.

## 4. Positive Signale

- `bun run test`: 197 Plugin-Tests gruen.
- `bunx tsc --noEmit`: gruen.
- `bun run wasm:check`: committed WASM frisch.
- Server `cargo test --workspace --locked`: 36 Tests gruen.
- Server `cargo clippy --workspace --locked -- -D warnings`: gruen.
- Live server: Container healthy, RestartCount 0 in Snapshot.
- Gute Korrektheitsmechanismen vorhanden: path policy, delete journal mit Reconcile, sticky tombstones, Argon2id, generische Auth-Fehler, URL-TLS-Policy, Android dirty tracking.

## 5. Minimum Pre-Handoff Checklist

1. Server: Healthcheck gruen, Restart-Policy bestaetigt, DB-Backup erstellt.
2. Vault: Freund macht komplette lokale Vault-Kopie vor Plugin-Aktivierung.
3. Richard erstellt Vault-ID + starkes Passwort und gibt exakte URL ohne trailing slash.
4. BRAT-Install auf Zielgeraet testen.
5. Erster Sync auf Testvault, nicht direkt auf produktivem Freund-Vault.
6. Zweites Geraet oder Android testen, falls geplant.
7. Edit, Delete, Rename, Offline-Reconnect, Server-Restart testen.
8. Keine unerwarteten Conflict-Copies; falls doch, stoppen und klaeren.
9. Rollback-Prozedur schriftlich: Plugin deaktivieren, Vault aus Backup wiederherstellen, Server-Vault ggf. resetten.

## 6. Commands run / intentionally not run

### Ausgefuehrt

```bash
bun run test
bunx tsc --noEmit
bun run wasm:check
cd ../vaultcrdt-server && cargo test --workspace --locked
cd ../vaultcrdt-server && cargo clippy --workspace --locked -- -D warnings
git status --short
git tag --sort=-creatordate | head -10
git log -1 --oneline
```

Dazu read-only Dateiinspektion via `read`, `grep`, `find`, `ls`.

### Bewusst nicht ausgefuehrt

```bash
bun test
bun run build
bun run wasm
deploy/restart/tag/push/release
ssh home
```

`bun run build` wurde ausgelassen, weil es `main.js` ueberschreibt. `bun run wasm` wurde gemaess Guardrail nicht ausgefuehrt.
