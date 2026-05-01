Info bleibt nur noch fuer aggregiertes `request_doc_list` (Counts, kein Pfad). Alle per-Dokument-Logs sind auf Debug.

---

# Bericht | Server Ops/Privacy Hardening fuer Freundin-Handoff

## 1. Geaenderte Dateien

In `/home/richard/projects/vaultcrdt-server/`:

- `Cargo.toml` — `tracing-subscriber` mit `env-filter`-Feature aktiviert.
- `src/main.rs` — `EnvFilter`-basierter Subscriber, Default `info,loro=warn`, ueber `RUST_LOG` ueberschreibbar.
- `src/ws.rs` — Idle-Timeout auf 120s, Kommentar korrigiert (vorher 60s mit Kommentar "5 min").
- `src/handlers.rs` — Per-Dokument-Logs (`sync_start`, `sync_push`, `doc_create`, `doc_delete`, refused tombstone create/push) von `info!` auf `debug!` gesenkt; `request_doc_list` (aggregierte Counts) bleibt auf `info!`.
- `.env.example` — `VAULTCRDT_TOMBSTONE_DAYS` mit Empfehlung 365 ergaenzt.
- `README.md` — Status auf `0.2.6` korrigiert; `VAULTCRDT_TOMBSTONE_DAYS` und `RUST_LOG` in der Env-Tabelle ergaenzt; Security-Model um Operator-Zugriff/Logging-Hinweis erweitert; Backup/Restore-Sektion fuer SQLite/Docker-Compose hinzugefuegt.
- `docker-compose.yml` — `restart: unless-stopped` ergaenzt.

Keine Plugin-Quellen veraendert. Kein Commit/Push/Tag/Deploy/Restart.

## 2. Was umgesetzt wurde

### Item 1 — WS-Idle-Timeout
- Server-Idle auf **120s** angehoben (Plugin-Heartbeat 30s -> 4-fache Reserve).
- Kommentar auf "Idle timeout: must comfortably exceed the plugin's 30s heartbeat" korrigiert; alter widerspruechlicher Kommentar "5 min" entfernt.
- Verhalten bleibt `tokio::select! { ws_stream.next() ; sleep(120s) -> None }`, also unveraendert testbar; bestehende WS-Integration-Tests laufen weiter durch.

### Item 2 — Privacy-freundliches Default-Logging
- Per-Dokument-Logs auf `debug!`: `sync_start` (DocUnknown / incremental delta / full snapshot), `sync_push`, `doc_create`, `doc_delete`, `sync_push refused (tombstoned)`, `doc_create refused (tombstoned)`.
- Aggregat-Logs bleiben auf `info!`: Server-Start (`VaultCRDT server listening`), Shutdown, Vault-Auth (`auth: vault_id=...`), `request_doc_list` (Counts), Tombstone-/Peer-Expiry, DB-Maintenance, WS connect/disconnect.
- Warn/Error-Pfade unveraendert; sie erwaehnen `doc_uuid` heute nur noch indirekt ueber `process_message`-Fehler-Strings — die fuehren `loro` oder `msgpack`-Diagnose und enthalten keinen Pfad.
- `tracing-subscriber` mit `env-filter`-Feature; `EnvFilter::try_from_default_env()` nimmt `RUST_LOG` an, ansonsten Default `info,loro=warn`. Damit wird Loro-Internal-Noise per Default unterdrueckt, ohne dass Operator etwas setzen muss.

### Item 3 — Tombstone-Retention
- `.env.example`: `VAULTCRDT_TOMBSTONE_DAYS=365` als auskommentierte Empfehlung mit Begruendung (verhindert Resurrection nach langer Offline-Zeit eines Geraets, ueber 365 Tagen kostet pro geloeschtem Doc geringfuegig Disk und einen leicht groesseren initialen `DocList`).
- `README.md` Env-Tabelle: Eintrag mit gleicher Empfehlung.
- Live-Wert auf dem Server wurde nicht ueber SSH gequeried (Task sagt explizit "likely not needed"; ueber `.env` regelt der Operator).

### Item 4 — README/Version/Backup/Restart
- README-Status `0.2.4` -> `0.2.6` (passt jetzt zu `Cargo.toml`). Kein Versions-Bump, kein Release.
- Backup/Restore-Sektion: Online-Backup ueber `docker compose exec server sqlite3 ... .backup`, Cold-Backup mit `data.db`+`-wal`+`-shm`, Restore-Schritt mit gestopptem Container und Loeschen alter WAL/SHM. Hinweis, dass nach Restore CRDT-Merge ungeschickte Client-Edits nicht verliert.
- Security-Model erweitert: Operator kann Daten technisch lesen (kein E2E), Default-Logs sind minimiert, Support/Debug ueber `RUST_LOG=vaultcrdt_server=debug` macht Dokument-Namen sichtbar.
- `docker-compose.yml`: `restart: unless-stopped` gesetzt, damit nach Host-/Docker-Neustart der Dienst zurueckkommt, aber `docker compose stop` respektiert wird.

## 3. Checks und Ergebnisse

```
cargo fmt --all                                               -> clean
cargo clippy --all-targets -- -D warnings                     -> clean
cargo test --workspace                                        -> 36 passed, 0 failed
```

Alle WS-Integration-Tests inklusive `test_ws_concurrent_sync_push_merge`, `test_ws_doc_delete_and_broadcast`, `test_doc_delete_vs_sync_push_race` und der TOCTOU-Regression sind nach der Idle-Timeout-Aenderung gruen.

## 4. Uebersprungene Punkte

Keine. Alle vier Items aus dem Handoff sind umgesetzt.

Bewusst nicht angefasst:
- Kein Versions-Bump in `Cargo.toml` (Handoff sagt "do not create a release").
- Keine SSH-Inspektion des Live-`VAULTCRDT_TOMBSTONE_DAYS`. Default am laufenden Server bleibt 90 Tage, bis Richard `.env` setzt und neu startet — das ist explizit Operator-Entscheidung.
- Kein neuer CHANGELOG-Eintrag fuer 0.2.7 oder aehnliches, weil kein Release.
- Plugin-seitige `.md`-only Korrektur, URL-Normalisierung, Tombstone-Notice usw. sind im Plugin-Repo Aufgabe und ausserhalb dieses Server-Tasks.

## 5. Verbleibende Risiken fuer den Handoff

1. **Live-Server laeuft noch mit altem Build**: Diese Aenderungen liegen nur im Quellcode; sie greifen erst nach Neubau und Container-Restart. Bis Richard explizit deployed, sieht der laufende Server weiter Dokumentpfade auf Info-Level und hat Idle-Timeout 60s. Minimaler Schritt vor dem produktiven Friend-Onboarding: Server neu bauen (`docker compose build`) und kontrolliert restarten (`docker compose up -d`).
2. **Tombstone-Retention auf dem Live-Host**: solange `VAULTCRDT_TOMBSTONE_DAYS` nicht in `.env` gesetzt wird, bleibt der Default 90 Tage. Wenn die Freundin oder ein Geraet von ihr laenger als 90 Tage offline ist, koennten alte geloeschte Dokumente per Resurrection zurueckkommen. Empfehlung steht in `.env.example` und README; Setzen muss Richard.
3. **Kein E2E**: Datenschutz bleibt rein organisatorisch. Logs minimieren das Risiko fuer den Alltag, aber die SQLite-Datei und Backups enthalten Klartext-CRDT-Snapshots der Markdown-Notizen. Das ist im Security-Model jetzt explizit dokumentiert, aber technisch unveraendert.
4. **`debug!`-Aktivierung im Supportfall**: Wenn Richard zur Diagnose `RUST_LOG=vaultcrdt_server=debug` setzt, tauchen Dokumentpfade wieder im Log auf. Das ist als Aufwand-/Schutz-Tradeoff dokumentiert; im Supportprozess sollte Richard Logs vor Weitergabe immer scrubben.
5. **Idle-Timeout vs Hosting-Setup**: 120s ist gegen die Heartbeat-Drift abgesichert, aber wenn der Reverse-Proxy (Traefik o.ae.) ein eigenes WS-Idle-Timeout < 120s hat, bleibt Reconnect-Churn moeglich. Sollte beim Smoke-Test gegen Richards Server explizit beobachtet werden; bei Bedarf Proxy-Timeout angleichen.
6. **Backup-Anleitung ungetestet auf Richards Setup**: Das Runbook ist gegen den `docker-compose.yml`-Standardpfad (`./data`) geschrieben. Falls Richards Live-Setup einen anderen Volume-Pfad verwendet, muessen die Pfade angepasst werden.
