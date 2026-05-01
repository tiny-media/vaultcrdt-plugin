# Session Handoff — Friend-Handoff-Haertung vorbereitet

Datum: 2026-05-01
Branch: `main`
Plugin-Release live: `v0.3.0`
Server-Release live auf `home`: `v0.2.6`

## Status in einem Satz

Die externe Audit-Runde fuer die Uebergabe an Richards Freundin ist abgeschlossen, die kleinen Plugin- und Server-Haertungen sind lokal umgesetzt und validiert, aber noch nicht committed/deployed/released und noch nicht produktiv freigegeben.

## Zielprofil fuer die Uebergabe

- Zielgeraete: PC, Mac, iPad, Android.
- Server: Richards bestehender Server auf `home`.
- Vault: bestehender produktiver Vault der Freundin.
- Start: direkt produktiv.
- Keine E2E-Verschluesselung in dieser Runde.
- Datenschutz: organisatorisch plus minimierte Logs, nicht kryptographisch garantiert.

## Audit-Artefakte

Neuer laufender Zyklus:

```text
gpt-audit/archive-2026-04-30-friend-handoff-stability/
```

Wichtigste Dateien:

- `audit-claude1-2026-04-30.md`
- `audit-pi-gpt55-xhigh-2026-04-30.md`
- `01-synthesis-and-next-actions.md`
- `02-pre-handoff-plan.md`
- `03-friend-target-profile.md`
- `06-fresh-session-briefing.md`
- `live-server-observation.md`

## Plugin-Haertung umgesetzt

- `src/url-policy.ts`: `normalizeServerUrl()` ergaenzt; HTTP/WS-Bases strippen trailing slashes.
- `src/setup-modal.ts`: Setup persistiert normalisierte URL und nutzt `toHttpBase()`.
- `src/settings.ts`: Settings persistieren normalisierte URL.
- `src/sync-engine.ts`: `doc_tombstoned` zeigt deduplizierte Notice statt nur Log.
- `src/sync-initial.ts`: Conflict-Kopien zeigen Notice mit Pfad.
- `README.md`: Sync-Scope auf Markdown `.md` korrigiert.
- `main.js`: durch `bun run build` neu gebaut.

Bewusst nicht umgesetzt:

- Keine automatische Conflict-Kopie fuer `doc_tombstoned`.
- Kein sync-aware Auto-Push fuer Conflict-Dateien; Notice reicht fuer diese Runde.

Plugin-Checks zuletzt gruen:

```bash
bunx tsc --noEmit
bun run test        # 206 Tests gruen
bun run build       # gruen, bekannte import.meta-WASM-Warnung
bun run wasm:check  # OK
```

## Server-Haertung umgesetzt im Schwesterrepo

Repo: `/home/richard/projects/vaultcrdt-server`

- `src/ws.rs`: WS idle timeout 60s -> 120s.
- `src/handlers.rs`: per-document logs von `info!` auf `debug!` gesenkt.
- `src/main.rs`: EnvFilter Default `info,loro=warn,loro_internal=warn`.
- `Cargo.toml`: `tracing-subscriber` mit `env-filter` Feature.
- `README.md`: Version 0.2.6, Backup/Restore, Security-/Operator-Hinweise, Env-Tabelle.
- `.env.example`: `VAULTCRDT_TOMBSTONE_DAYS=365` Empfehlung.
- `docker-compose.yml`: `restart: unless-stopped`.
- `Dockerfile`: Runtime installiert `sqlite`, damit dokumentierter `.backup`-Befehl funktioniert.
- `.dockerignore`: neu, damit Remote-Docker-Builds nicht `target/`, `data/`, Secrets oder `.git/` uebertragen.

Server-Checks zuletzt gruen:

```bash
cd ../vaultcrdt-server
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --workspace  # 36 Tests gruen
```

Remote-Validierung:

- `ssh home`: Asahi/Fedora aarch64, Docker und Rust 1.94 vorhanden.
- Server-Code per rsync nach `/tmp/vaultcrdt-server-remote-check` kopiert.
- Auf `home`: `cargo test --workspace --quiet` gruen.
- Auf `home`: `docker build -t vaultcrdt-server:remote-build-check .` gruen.
- `ssh macStudio`: macOS arm64 mit Rust 1.94, aber ohne Docker/Podman/Bun/Node; geeignet fuer cargo-only Checks, nicht fuer deploybare Linux-Docker-Artefakte.

Memory:

- `proc-20260501-c626 — Use remote ARM hosts for long VaultCRDT server builds`

## Noch offen vor Weitergabe

1. Aenderungen reviewen und committen.
2. Versionierung entscheiden:
   - Plugin evtl. `0.3.1`.
   - Server evtl. `0.2.7`.
3. Server-Deploy auf `home` nur nach expliziter Freigabe.
4. Live-Server `.env` pruefen/setzen: `VAULTCRDT_TOMBSTONE_DAYS=365`.
5. Live-Backup vor Deploy ziehen.
6. Finale Freundin-Anleitung schreiben, wahrscheinlich `docs/freundin-handoff.md`.
7. Smoke-Test mit Testvault oder bewusstem Produktiv-Backup:
   - Desktop Push/Pull.
   - Mobile/iPad/Android aktiv-offen Sync.
   - Delete/Rename/Offline-Reconnect.
   - Server-Restart/Reconnect nur nach Freigabe.
8. Produktiven Vault der Freundin erst nach Backup und Richards finaler Freigabe registrieren.

## Harte Guardrails bleiben

- Kein Deploy, Release, Tag, Push oder Server-Restart ohne explizite Freigabe.
- `wasm/` nicht manuell editieren.
- `bun run test`, nie `bun test`.
- Android `mtime` nie fuer Caching/Skip-Logik.
- Keine Secrets, Admin Tokens, Passwoerter oder echten Vault-Werte in Git.

## Empfohlener Start fuer die naechste Session

1. `CLAUDE.md`, `AGENTS.md`, `next-session-handoff.md` lesen.
2. `gpt-audit/archive-2026-04-30-friend-handoff-stability/06-fresh-session-briefing.md` lesen.
3. Repo-Status in Plugin und Server pruefen.
4. Geaenderte Dateien reviewen.
5. Danach Commit-Schnitt, Versionierung und Deploy-/Anleitungsreihenfolge entscheiden.
