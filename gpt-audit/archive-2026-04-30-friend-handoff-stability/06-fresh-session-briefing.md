# Fresh Session Briefing | Friend-Handoff-Stability

Datum: 2026-05-01
Ziel: Frische Session soll ohne breite Re-Exploration die letzten Schritte bis zur sicheren Uebergabe an Richards Freundin steuern.

## Kurzstatus

Die externe Audit- und Haertungsrunde ist weitgehend umgesetzt, aber noch nicht deployed, released oder an die Freundin weitergegeben.

Wichtig: Es gibt Aenderungen in **zwei Repos**:

```text
/home/richard/projects/vaultcrdt-plugin
/home/richard/projects/vaultcrdt-server
```

Keine Deploys, Releases, Tags, Pushes oder Service-Restarts wurden durchgefuehrt.

## Zielprofil

- Zielgeraete: PC, Mac, iPad, Android.
- Server: Richards bestehender Server auf `home`.
- Vault: bestehender produktiver Vault der Freundin.
- Start: direkt produktiv.
- Keine E2E-Verschluesselung in dieser Runde.
- Datenschutz: organisatorisch plus minimierte Logs, nicht kryptographisch garantiert.

## Audit-Artefakte

Relevant sind im Archiv:

- `00-audit-scope.md`
- `audit-claude1-2026-04-30.md`
- `audit-pi-gpt55-xhigh-2026-04-30.md`
- `01-synthesis-and-next-actions.md`
- `02-pre-handoff-plan.md`
- `03-friend-target-profile.md`
- `04-task-plugin-hardening-handoff.md`
- `05-task-server-ops-privacy-handoff.md`
- `report-plugin-hardening-claude1-2026-04-30.md`
- `report-server-ops-privacy-claude2-2026-04-30.md`
- `live-server-observation.md`

## Bereits umgesetzt im Plugin-Repo

Geaenderte Hauptbereiche:

- `src/url-policy.ts`
  - `normalizeServerUrl()` ergaenzt.
  - `toHttpBase()` / `toWsBase()` strippen trailing slashes.
- `src/setup-modal.ts`
  - Setup persistiert normalisierte Server-URL.
  - `/auth/verify` nutzt `toHttpBase()`.
- `src/settings.ts`
  - Settings persistieren normalisierte Server-URL.
- `src/sync-engine.ts`
  - `doc_tombstoned` zeigt deduplizierte Obsidian Notice.
  - Keine automatische Conflict-Copy fuer tombstoned Docs.
- `src/sync-initial.ts`
  - Conflict-Kopien zeigen Notice mit Pfad.
  - Keine sync-aware Conflict-Push-Architektur eingebaut.
- `README.md`
  - `.md`-only korrigiert.
- Tests angepasst:
  - `src/__tests__/url-policy.test.ts`
  - `src/__tests__/setup-modal.test.ts`
  - `src/__tests__/sync-engine.test.ts`
  - `src/__tests__/sync-engine-edge.test.ts`
- `main.js`
  - Durch `bun run build` neu gebaut.

Plugin-Checks bereits gruen:

```bash
bunx tsc --noEmit
bun run test        # 206 Tests gruen
bun run build       # gruen, bekannte import.meta-WASM-Warnung
bun run wasm:check  # OK: committed WASM artifacts are fresh
```

## Bereits umgesetzt im Server-Repo

Geaenderte Hauptbereiche in `../vaultcrdt-server`:

- `src/ws.rs`
  - WS idle timeout 60s -> 120s.
  - Kommentar korrigiert.
- `src/handlers.rs`
  - Per-Dokument-Logs von `info!` auf `debug!` gesenkt.
  - `request_doc_list` bleibt als aggregierter Count auf Info-Level.
- `src/main.rs`
  - EnvFilter-basierter Subscriber.
  - Default: `info,loro=warn,loro_internal=warn`.
- `Cargo.toml`
  - `tracing-subscriber` mit `env-filter` Feature.
- `.env.example`
  - `VAULTCRDT_TOMBSTONE_DAYS=365` Empfehlung dokumentiert.
- `README.md`
  - Status auf 0.2.6 korrigiert.
  - Env-Tabelle erweitert.
  - Security-/Operator-Zugriff klargestellt.
  - Backup/Restore-Runbook fuer SQLite ergaenzt.
- `docker-compose.yml`
  - `restart: unless-stopped` ergaenzt.
- `Dockerfile`
  - Runtime installiert jetzt `sqlite`, damit dokumentierter `sqlite3 .backup` Befehl im Container funktioniert.
- `.dockerignore`
  - Neu, damit Docker-Kontext nicht `target/`, `data/`, `.git/`, Secrets usw. uebertraegt.

Server-Checks bereits gruen:

```bash
cd ../vaultcrdt-server
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --workspace  # 36 Tests gruen
```

Remote-Validierung:

- `ssh home` ist Asahi/Fedora aarch64 mit Docker und Rust 1.94.
- Server-Code wurde per rsync nach `/tmp/vaultcrdt-server-remote-check` kopiert.
- Auf `home` lief `cargo test --workspace --quiet` gruen.
- Auf `home` lief `docker build -t vaultcrdt-server:remote-build-check .` gruen.
- `ssh macStudio` ist macOS arm64 mit Rust 1.94, aber ohne Docker/Podman/Bun/Node.
- `macStudio` eignet sich aktuell fuer cargo-only Checks, nicht fuer deploybare Linux-Docker-Artefakte.

Memory dazu:

- `proc-20260501-c626 — Use remote ARM hosts for long VaultCRDT server builds`

## Wichtige offene Punkte

### 1. Review der Aenderungen

Vor Commit/Deploy sollte eine frische Session die geaenderten Dateien reviewen:

- Plugin: URL-Normalisierung, Notices, README, Tests, `main.js`.
- Server: Logging-Level, EnvFilter, Dockerfile, `.dockerignore`, Backup-Doku.

Besonders pruefen:

- `normalizeServerUrl()` strippt bei Root-URLs nicht versehentlich `https://` zu `https:`. Aktuelle Tests decken normale URLs ab.
- Backup-Doku nutzt `docker compose exec server sqlite3`; Dockerfile installiert jetzt `sqlite`.
- `RUST_LOG` Default stimmt zwischen `src/main.rs` und README.

### 2. Versionierung entscheiden

Noch nicht entschieden:

- Plugin auf `0.3.1` bumpen und GitHub/BRAT Release erstellen?
- Server auf `0.2.7` bumpen, Image bauen und auf `home` deployen?

Da Code in beiden Repos geaendert wurde, ist ein Versions-Bump wahrscheinlich sinnvoll, aber nur nach Richards Freigabe.

### 3. Commit-Reihenfolge

Empfohlen:

1. Plugin-Commit: Friend-Handoff-Haertung + Audit-Artefakte + Memory/Setup-Paket getrennt oder bewusst zusammen schneiden.
2. Server-Commit im Schwesterrepo: Ops/Privacy-Haertung.
3. Danach optional Version-Bump-Commits.

Vor Commit:

- Plugin: `bun run wasm:check && bun run test && bun run build`, ggf. `bunx tsc --noEmit`.
- Server: `cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo test --workspace`.

### 4. Deploy nur mit Freigabe

Noch nicht gemacht:

- Server auf `home` deployen/restarten.
- Live-`.env` auf `VAULTCRDT_TOMBSTONE_DAYS=365` setzen.
- Live-Logging nach Deploy pruefen.
- Plugin deployen oder releasen.

Wichtig: Live-Server laeuft weiter mit altem Build, bis deployed wird.

### 5. Finale Freundin-Anleitung schreiben

Noch fehlt die eigentliche Anleitung fuer die Freundin.

Empfohlen: `docs/freundin-handoff.md`

Muss enthalten:

1. Was VaultCRDT tut und nicht tut.
2. Kein E2E: Richard/Serverbetreiber koennte Daten technisch lesen.
3. Backup vor Installation.
4. BRAT-Installation.
5. Setup-Werte ohne Admin Token.
6. Nur `.md` wird synchronisiert.
7. Verhalten bei Conflict-Kopien und Tombstone-Notice.
8. iPad/Android: Sync wenn Obsidian aktiv offen ist; Hintergrund kann pausieren.
9. Rollback.
10. Was sie Richard bei Problemen schicken soll, ohne Passwort/Tokens.

### 6. Produktiver Handoff erst nach Smoke-Test

Noch ausstehend:

- Server-Backup ziehen.
- Testvault/Vault-Registrierung klaeren.
- Desktop + Mobile Smoke-Test.
- Wenn direkt produktiv: vor Plugin-Aktivierung vollstaendiges Vault-Backup der Freundin.

## Naechster praeziser Arbeitsschritt fuer die frische Session

1. `CLAUDE.md`, `AGENTS.md`, `next-session-handoff.md` lesen.
2. Diese Datei lesen: `gpt-audit/archive-2026-04-30-friend-handoff-stability/06-fresh-session-briefing.md`.
3. Geaenderte Dateien reviewen.
4. Danach entscheiden: erst Commit/Versionierung oder erst finale Freundin-Anleitung.

Empfehlung: **erst Review und Commit-Schnitt klaeren**, dann Anleitung schreiben, dann Deploy/Release/Smoke-Test.
