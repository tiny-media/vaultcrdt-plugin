# Session Handoff — nach Phase B

Datum: 2026-04-07
Branch: main (alle drei Repos)

## Was diese Session gemacht hat

Phase B des GPT-Audits vollständig umgesetzt — Items 4, 5, 6. Vier Commits:

| Commit | Repo | Inhalt |
|--------|------|--------|
| `124a2d7` | vaultcrdt-server | Argon2id-Hashing + Lazy-Migration, generische Auth-Fehler, Tombstone-Guard (`is_tombstoned`), neuer `DocTombstoned`-ServerMsg, 90d Default-Retention via `VAULTCRDT_TOMBSTONE_DAYS` |
| `3280be4` | vaultcrdt-plugin | `removeAndClean()` statt `remove()` in Delete-Pfaden, neuer `case 'doc_tombstoned'` |
| `b18532c` | parent (`/home/richard/projects`) | `wasm-bindgen = "=0.2.114"` Pin im Monorepo, `scripts/build-wasm.sh`, `scripts/check-wasm-fresh.sh`, Justfile-Update |
| `a2bc6f3` | vaultcrdt-plugin | `gpt-audit/claude-response.md` mit Phase-B-Notizen + Lessons Learned |

**Tests:** Server 35/35, Plugin 129/129. Plugin-Build sauber.

**6 von 8 Audit-Punkten umgesetzt.** Verbleibend: Multi-Editor-Konsistenz (#7) und WS-Token-Logging (#8) — beide bewusst aufgeschoben.

## Status der Audit-Roadmap

Siehe `gpt-audit/claude-response.md` (vollständig aktualisiert) und `gpt-audit/09-decision-matrix.md`.

## Offene Followups

### 1. Monorepo-Workspace reparieren (Blocker für `cargo check`)

`/home/richard/projects/vaultcrdt/Cargo.toml` listet `v2/server` als Workspace-Member, das Verzeichnis existiert aber nicht. `cargo check --workspace` schlägt sofort fehl. Pre-existing, nicht durch Phase B verursacht.

**Optionen:**
- `v2/server`-Eintrag aus `[workspace] members` entfernen (wenn die v2-Linie tot ist)
- `v2/server/Cargo.toml` neu anlegen (wenn sie wiederbelebt werden soll)

**Konsequenz:** Erst nach Fix kann `just wasm-check` lokal validieren, dass die committed Plugin-WASMs frisch sind.

### 2. WASM-Build-Skripte einmal real laufen lassen

`scripts/build-wasm.sh` und `scripts/check-wasm-fresh.sh` sind geschrieben, aber wegen #1 nie ausgeführt. Sobald der Workspace baut: `just wasm` einmal aufrufen, prüfen ob die Output-Pfade stimmen, Diff zu den committed Artefakten ansehen.

### 3. Lazy-Auth-Migration im Real-Betrieb beobachten

Beim ersten Login eines existierenden Vaults nach Server-Update wird der Klartext-API-Key automatisch zu Argon2id-PHC upgegradet. Empfehlung: einmal im Server-Log nach dem ersten Verify nachschauen, dass der `UPDATE vaults SET api_key` durchläuft und nachfolgende Verifies den `$argon2id$`-Pfad nehmen.

### 4. Plugin-Verhalten nach Delete prüfen

Nach einem lokalen Delete sollte das Plugin nicht mehr für denselben Pfad pushen. Aktuell passiert das implizit (`DocumentManager` kennt den Doc nach `removeAndClean()` nicht mehr). Wenn etwas doch erneut pusht, antwortet der Server jetzt mit `DocTombstoned` und das Plugin loggt eine Warnung — beides im Console-Log sichtbar machen, falls auffällig.

### 5. Aufgeschobene Items (#7, #8)

- **#7 Multi-Editor-Konsistenz** — UX-Polish, kein Korrektheitsproblem
- **#8 WS-Token-Logging** — Self-Hosted ausreichend, Ticket-Modell wäre nice-to-have

Beide würde ich erst angehen, wenn ein Public Release konkret wird.

## Wichtige Kontextinfos

- **Einziger User**, kein Backwards-Compat-Zwang
- **Android-mtime unzuverlässig** — niemals für Caching/Skip-Logik
- **`/home/richard/projects/vaultcrdt`** lebt **inside** des Eltern-Git-Repos `/home/richard/projects/` — Commits dort mit explizit gestageten Pfaden machen, sonst zeigt `git status` dutzende Geschwister-Projekte
- **Server-Repo:** `/home/richard/projects/vaultcrdt-server` (eigenes Repo)
- **Plugin-Repo:** `/home/richard/projects/vaultcrdt-plugin` (eigenes Repo)
- **Monorepo:** `/home/richard/projects/vaultcrdt` (Subdir im Parent-Repo)

## Deploy-Hinweise für Phase-B-Änderungen

- **Server:** `VAULTCRDT_TOMBSTONE_DAYS=90` ist Default, kein Setzen nötig wenn 90 ok ist. Argon2-Migration läuft automatisch bei nächstem Login.
- **Plugin:** `main.js` im Commit `3280be4` enthalten. Standard-Deploy-Pfad (Plugin-Kopie an die 4 bekannten Orte).
- **Monorepo:** Commit `b18532c` lebt im Parent-Repo, nicht im `vaultcrdt`-Subdir.

## Dateien zum Lesen als Einstieg

- `gpt-audit/claude-response.md` — vollständige Bewertung + Phase-A/B-Status + Lessons Learned
- `gpt-audit/09-decision-matrix.md` — Übersicht aller 8 Audit-Punkte
- `gpt-audit/next-session-phase-b.md` — Plan, der diese Session umgesetzt hat (jetzt historisch)
