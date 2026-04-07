# Session Handoff — nach Drift-Discovery + CLAUDE.md-Orientation

Datum: 2026-04-07 (dritte Session des Tages)
Branch: main (alle Repos)

## Was diese Session erreicht hat

**1. Option A′ (Phase-B-Abschluss-Smoke-Test):**
- `vaultcrdt/Cargo.toml`: `"v2/server"` aus members entfernt (Eltern-Repo commit `13ba39f`)
- `cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release` → grün
- `./scripts/check-wasm-fresh.sh` → `OK: committed WASM artifacts are fresh`
- **Phase B Item 5 (wasm-bindgen Pin) ist damit end-to-end verifiziert.** Die committed Plugin-WASM-Artefakte sind bit-identisch reproduzierbar.

**2. Drift-Discovery zwischen Monorepo und standalone Server:**
- Source-Drift in `crates/vaultcrdt-{wasm,crdt}` zwischen `vaultcrdt/` und `vaultcrdt-server/`
- Der bit-identische Build-Beweis zeigt: **`vaultcrdt/` ist die Source-of-Truth**, die Kopien im standalone Server waren stale Forks vom Split-Zeitpunkt

**3. Standalone Server aufgeräumt (commit `084daf3`):**
- `vaultcrdt-server/crates/` komplett gelöscht (1141 Zeilen dead code)
- `vaultcrdt-server/Cargo.toml` members auf `["."]` reduziert, `[workspace.dependencies]` block entfernt
- `cargo build` + `cargo test` → 35/35 grün

**4. CLAUDE.md-Orientation in allen drei Repos:**
- `vaultcrdt-plugin/CLAUDE.md` — neu, mit Drei-Repo-Layout, gpt-audit/-Navigation, `bun run test` vs `bun test` Warnung, Invarianten
- `vaultcrdt-server/CLAUDE.md` — neu, mit Drei-Repo-Layout, Phase B Status, Env-Vars, Auth-/Tombstone-Invarianten
- `vaultcrdt/CLAUDE.md` — überarbeitet mit expliziter "LEGACY" Kennzeichnung, Live-Zweck (nur WASM-Build), D1-D7 Cleanup-Liste, Gotcha zum Eltern-Git-Repo

Jedes zukünftige Coding-Tool, das einen der drei Ordner öffnet, bekommt jetzt sofort die wichtigste Info: welcher Ordner bin ich, welche zwei anderen gibt es, wo ist die Source-of-Truth, was darf ich nicht kaputt machen.

## Nächste Session: D1-D7 — Monorepo-Cleanup

Der 2026-03-19 Split (`b3afcf2`) war unvollständig. Folgender dead code lebt im Monorepo und ist seit 3 Wochen tot, aber nie aufgeräumt:

| # | Was | Aktion |
|---|---|---|
| D1 | `crates/vaultcrdt-server/` | Löschen (drifted Snapshot, canonical ist `../vaultcrdt-server/`) |
| D2 | standalone `crates/{wasm,crdt}/` | ✅ bereits erledigt (`084daf3`) |
| D3 | `Dockerfile` referenziert nicht-existentes `vaultcrdt-server-v2` | Löschen |
| D4 | `.forgejo/workflows/release.yaml` baut kaputten Dockerfile | Löschen |
| D5 | `Justfile` hat ~10 dead targets (`run`, `deploy`, `restart`, `build-remote`, `build-docker`, `logs`, `status`, `e2e`, `e2e-train`, `shell`) | Trimmen auf `wasm` / `wasm-check` / `check` |
| D6 | `Cargo.lock` Leicheneintrag `vaultcrdt-server-v2` | Regenerieren (`cargo update -w` nach D1) |
| D7 | `obsidian-plugin/` — vierte vollständige Plugin-Kopie mit eigenem `main.js`, `wasm/`, `node_modules/` | **Mit User klären**, wahrscheinlich löschen |

**Ausserdem:**
- `docker-compose.yml` löschen (baut den kaputten Dockerfile)
- `Cargo.toml` `[workspace.dependencies]` ausmisten — nach D1 sind server-only deps (axum, sqlx, jsonwebtoken, tower, tower-http, libsqlite3-sys, rmp-serde, futures-util, clap, anyhow, tracing-subscriber) überflüssig

### Vorgeschlagener Ablauf

1. **D7 zuerst klären** (30 Sekunden Konversation mit User) — ist `obsidian-plugin/` im Monorepo Altlast oder dient sie noch irgendwas?
2. **D1, D3, D4, `docker-compose.yml` löschen** — ein Commit „retire dead deploy pipeline"
3. **D5, Cargo.toml `[workspace.dependencies]`, D6** — ein Commit „trim monorepo to WASM build role"
4. **Smoke-Test nach jedem Commit:** `cargo build -p vaultcrdt-wasm --target wasm32-unknown-unknown --release` + `./scripts/check-wasm-fresh.sh`
5. **CLAUDE.md im Monorepo final updaten** — D1-D7 als erledigt markieren, Cleanup-Section entfernen

**Aufwand:** ~45 min, ~5 Edit-Stellen, nichts davon risky weil alles seit 3 Wochen nachweislich tot ist.

**Commit-Gotcha:** Alle Änderungen im Monorepo müssen in den Eltern-Repo `/home/richard/projects/` committed werden mit expliziten Pfaden (`git add vaultcrdt/path`).

## Offene Runtime-Observations (unverändert)

- **Lazy-Auth-Migration:** beim ersten Real-Login eines bestehenden Vaults soll der Klartext-API-Key automatisch zu Argon2id-PHC upgegradet werden. Server-Log beim ersten Verify beobachten.
- **Plugin nach Delete:** nach `removeAndClean()` sollte das Plugin nicht mehr für denselben Pfad pushen. Falls doch: Server antwortet mit `DocTombstoned` und Plugin loggt Warnung.

Beides bei normaler Nutzung im Blick behalten, kein separater Coding-Aufwand nötig.

## Aufgeschobene Audit-Items

- **#7 Multi-Editor-Konsistenz** — UX-Polish, kein Korrektheitsproblem, deferred bis Public Release
- **#8 WS-Token-Logging** — Self-Hosted ausreichend, Ticket-Modell nice-to-have, deferred

Beide gehören in eine Public-Release-Session, nicht jetzt.

## Commits dieser Session

| Commit | Repo | Inhalt |
|--------|------|--------|
| `13ba39f` | parent (`/home/richard/projects`) | monorepo Cargo.toml: drop dead `v2/server` member |
| `084daf3` | vaultcrdt-server | remove stale `crates/` leftover from repo split |
| — | vaultcrdt-plugin | CLAUDE.md + aktualisierter Handoff (nicht committed, bis User es will) |
| — | vaultcrdt-server | CLAUDE.md (nicht committed, bis User es will) |
| — | parent (`/home/richard/projects`) | vaultcrdt/CLAUDE.md Update (nicht committed, bis User es will) |

## Wichtige Kontextinfos (für jede künftige Session)

- **Einziger User**, kein Backwards-Compat-Zwang
- **Android-mtime unzuverlässig** — niemals für Caching
- **`vaultcrdt/`** ist Legacy, NUR für WASM-Build
- **`vaultcrdt/`** lebt inside `/home/richard/projects/`-Eltern-Repo → explizite Pfade beim `git add`
- **`bun run test`** verwenden, NICHT `bun test` (unterschiedliche Runner)
- **Drei CLAUDE.md-Dateien** existieren jetzt — jede erklärt sich selbst und die anderen beiden

## Einstiegspunkte für neue Sessions

1. `memory_session_start` (via `/begin`)
2. Diesen Handoff lesen
3. `CLAUDE.md` im aktuellen Arbeitsverzeichnis lesen
4. Bei Audit-Fragen: `gpt-audit/09-decision-matrix.md` und `gpt-audit/claude-response.md`
