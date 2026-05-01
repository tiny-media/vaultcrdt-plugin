# Session Handoff — Friend-Handoff Release deployed

Datum: 2026-05-01
Branch: `main`
Plugin-Release live: `v0.3.1`
Server-Release live auf `home`: `v0.2.7`

## Status in einem Satz

Plugin- und Server-Haertungen fuer die Uebergabe an Richards Freundin sind released, gepusht und der Server ist auf `home` deployed; produktiver Freundin-Handoff bleibt bis nach Smoke-Test und Richards finaler Freigabe gesperrt.

## Relevante Commits und Releases

Plugin-Repo `/home/richard/projects/vaultcrdt-plugin`:

- `844a415 fix(plugin): harden friend handoff sync UX`
- `0725f0d docs(gpt-audit): document friend handoff stability cycle`
- `9f04c83 chore(plugin): release 0.3.1`
- Tag/Release: `v0.3.1`

Server-Repo `/home/richard/projects/vaultcrdt-server`:

- `a367839 fix(server): harden ops privacy for friend handoff`
- `285d4ef chore(server): release 0.2.7`
- Tag/Release: `v0.2.7`

GitHub Actions:

- Plugin CI und Release fuer `v0.3.1` gruen.
- Server CI, Release und Docker fuer `v0.2.7` gruen.

## Plugin-Stand

Umgesetzt:

- Server-URL-Normalisierung in Setup und Settings.
- Sichtbare Notices fuer `doc_tombstoned` und Initial-Sync-Conflict-Kopien.
- README/Changelog/Manifest/Package/Versions auf `0.3.1` aktualisiert.
- Sync-Scope als Markdown `.md` only dokumentiert.
- Finale Freundin-Anleitung: `docs/freundin-handoff.md`.
- Smoke-Test-Plan: `docs/freundin-smoke-test.md`.

Plugin-Distribution:

- Kanonischer Weg ist jetzt BRAT/GitHub Releases.
- Alte lokale Copy-Deploys in Obsidian-Vault-Plugin-Ordner sind nicht mehr kanonisch.
- Neues Memory: `con-20260501-cc33 — Use BRAT for plugin distribution`.
- `.pi/skills/deploy/SKILL.md` wurde entsprechend entschärft.

Plugin-Checks zuletzt gruen:

```bash
bun run wasm:check
bun run test        # 206 Tests gruen
bun run build       # gruen, bekannte import.meta-WASM-Warnung
cargo fmt --all -- --check
cargo clippy --all-targets --workspace -- -D warnings
cargo test --workspace
bunx tsc --noEmit
```

## Server-Stand

Umgesetzt und deployed:

- WS idle timeout 120s.
- Per-document Logs auf `debug`, Default `RUST_LOG=info,loro=warn,loro_internal=warn`.
- `VAULTCRDT_TOMBSTONE_DAYS=365` live gesetzt.
- Backup/Restore-Doku und Runtime-`sqlite` verfuegbar.
- Docker restart policy `unless-stopped` aktiv.

Server-Checks zuletzt gruen:

```bash
cd ../vaultcrdt-server
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --workspace  # 36 Tests gruen
```

Live-Deploy auf `home`:

- Cold-Backup vor Deploy: `/opt/docker-setups-home/vaultcrdt/data/vaultcrdt-pre-0.2.7-20260501-153130.db`.
- Deployed via `/home/richard/fleet` mit Stack `vaultcrdt`.
- Container healthy, `/health` meldet `version: 0.2.7`.
- Runtime enthaelt `sqlite3`; `.backup` erfolgreich getestet:
  `/opt/docker-setups-home/vaultcrdt/data/vaultcrdt-post-0.2.7-smoke.db`.

Wichtig: Fleet-Repo hat eine uncommitted Aenderung in `hosts/home/stacks/vaultcrdt/compose.yaml` fuer `v0.2.7` und `VAULTCRDT_TOMBSTONE_DAYS=365`. Nicht automatisch committen/pushen ohne Richards Freigabe.

## Zielprofil fuer die Uebergabe

- Zielgeraete: PC, Mac, iPad, Android.
- Server: Richards bestehender Server auf `home`.
- Vault: bestehender produktiver Vault der Freundin.
- Start: direkt produktiv.
- Keine E2E-Verschluesselung in dieser Runde.
- Datenschutz: organisatorisch plus minimierte Logs, nicht kryptographisch garantiert.

## Noch offen vor produktivem Freundin-Handoff

1. Smoke-Test nach `docs/freundin-smoke-test.md` durchfuehren.
2. Vollbackup des produktiven Freundin-Vaults bestaetigen.
3. Test-/Freundin-Vault-ID und Passwort nur ausserhalb von Git handhaben.
4. Falls noetig: Server-Vault registrieren, ohne Admin Token zu dokumentieren.
5. iPad/Android aktiv-offen Sync bewusst testen oder Einschraenkung akzeptieren.
6. Richard muss final sagen:

```text
Freigabe: Produktiv-Handoff an Freundin mit Richards Server.
```

## Harte Guardrails bleiben

- Keine Secrets, Admin Tokens, Passwoerter oder echten Vault-Werte in Git.
- `bun run test`, nie `bun test`.
- `wasm/` nicht manuell editieren.
- Android `mtime` nie fuer Caching/Skip-Logik.
- Server-Kontext nur gezielt aus `../vaultcrdt-server` oder `/home/richard/fleet` laden.
