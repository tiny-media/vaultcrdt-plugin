# Session Handoff — Two-Repo Consolidation + Audit Cleanup

Datum: 2026-04-07 (vierte Session des Tages)
Branch: main (alle Repos)

## Was diese Session erreicht hat

### D1-D7: Legacy-Monorepo bereinigt (Commit `a379a36`, Eltern-Repo)

Alle 7 Cleanup-Punkte aus dem Backlog in einem Commit erledigt:
- `crates/vaultcrdt-server/` gelöscht (D1 — drifted snapshot)
- `Dockerfile`, `docker-compose.yml` gelöscht (D3)
- `.forgejo/` komplett gelöscht (D4 + CI)
- `devices/` gelöscht (leerer Stub)
- `obsidian-plugin/` gelöscht (D7 — stale vierte Plugin-Kopie)
- `Cargo.toml` auf 3 WASM-Crates reduziert + server-only deps entfernt
- `Justfile` auf `wasm / wasm-check / check / test` getrimmt (D5)
- `Cargo.lock` regeneriert, server-deps-frei (D6)

### Rust WASM-Crates in Plugin-Repo absorbiert (Plugin-Commit)

Endgültiger Abschluss des 2026-03-19-Splits. Das Plugin-Repo ist jetzt ein Rust+TS-Hybrid:

```
vaultcrdt-plugin/
├── crates/vaultcrdt-{core,crdt,wasm}/   ← Rust CRDT engine
├── scripts/{build-wasm.sh,check-wasm-fresh.sh}
├── Cargo.toml + Cargo.lock + .cargo/ + rust-toolchain.toml + rustfmt.toml
└── wasm/                                 ← committed artifacts (bit-identisch)
```

Neue Befehle:
```bash
bun run wasm         # rebuild WASM aus crates/
bun run wasm:check   # drift-guard gegen committed wasm/
```

Smoke-Test: `bun run wasm:check` → `OK: committed WASM artifacts are fresh` ✓  
`bun run test` → 129/129 ✓

### Legacy-Ordner pensioniert (Eltern-Repo)

`/home/richard/projects/vaultcrdt/` existiert nicht mehr.

**Finales Layout:**
```
/home/richard/projects/
├── vaultcrdt-plugin/    ← Rust CRDT engine + WASM build + TypeScript plugin
└── vaultcrdt-server/    ← Rust/Axum sync server
```

### gpt-audit/ bereinigt für neuen Audit-Zyklus

Erster Zyklus (2026-04-06) vollständig archiviert in `gpt-audit/archive-2026-04-06/`.

Neue Top-Level-Struktur:
```
gpt-audit/
├── README.md             ← Workflow für neue Zyklen
├── previous-cycles.md    ← rolling Summary, 1 Absatz pro geschlossenem Zyklus
└── archive-2026-04-06/   ← erster Zyklus, closed (6/8 done, 2 deferred)
```

---

## Nächste Session: Neuer GPT-Audit

**Vorbereitung ist erledigt.** Das Repo ist jetzt in einer sauberen Zwei-Repo-Struktur, die sich deutlich von der Drei-Repo-Struktur unterscheidet, die der erste Audit bewertet hat.

Ablauf:
1. GPT bekommt aktuelle Code-Basis (`vaultcrdt-plugin/src/`, `vaultcrdt-server/src/`) + Kontext aus `gpt-audit/previous-cycles.md`
2. Neues Audit landet in `gpt-audit/archive-<datum>/audit-<datum>.md`
3. Danach: Proposals, Decision-Matrix, Claude-Response wie im ersten Zyklus

**Seed-Kontext für den Audit-Prompt:** `gpt-audit/previous-cycles.md` — beschreibt was im ersten Zyklus bereits behoben wurde, verhindert Rehashing.

---

## Dauerhaft offene Punkte (deferred bis Public Release)

- **#7 Multi-Editor-Konsistenz** — UX-Polish, kein Korrektheitsproblem
- **#8 WS-Token-Logging** — Self-Hosted ausreichend, Ticket-Modell nice-to-have

Detail: `gpt-audit/archive-2026-04-06/claude-response.md`

## Runtime-Observations (bei normaler Nutzung beobachten)

- **Lazy-Auth-Migration:** Beim ersten Login eines bestehenden Vaults: Server-Log beobachten → PHC-Upgrade passiert beim ersten `verify_secret`-Aufruf
- **Plugin nach Delete:** Nach `removeAndClean()` pusht das Plugin nicht mehr für denselben Pfad. Falls doch → Server antwortet mit `DocTombstoned`, Plugin loggt Warnung.

---

## Commits dieser Session

| Commit | Repo | Inhalt |
|--------|------|--------|
| `a379a36` | parent (`/home/richard/projects`) | D1-D7: trim legacy monorepo to WASM build role |
| *(neu)* | vaultcrdt-plugin | feat(wasm): absorb Rust CRDT crates — retire legacy monorepo split |
| `c357354` | vaultcrdt-server | docs(claude): two-repo layout — legacy monorepo retired |
| *(neu)* | parent | retire legacy vaultcrdt/ monorepo |
| *(neu)* | vaultcrdt-plugin | docs(gpt-audit): archive first cycle, prep for new audit |

## Wichtige Kontextinfos

- **Einziger User**, kein Backwards-Compat-Zwang
- **Android-mtime unzuverlässig** — niemals für Caching
- **`bun run test`** verwenden, NICHT `bun test`
- **wasm-bindgen CLI** muss Version `0.2.114` sein (Cargo.toml-Pin); `bun run wasm:check` fängt Drift ab
- **Zwei CLAUDE.md-Dateien** — eine pro Repo, jede erklärt sich selbst und den Nachbarn
- **Eltern-Repo-Gotcha ist hinfällig** — `vaultcrdt/` ist weg, kein Parent-Git-Tanz mehr nötig

## Einstiegspunkte für neue Sessions

1. `/begin` (invokes `memory_session_start`)
2. Diesen Handoff lesen
3. `CLAUDE.md` im aktuellen Arbeitsverzeichnis lesen
4. Bei Audit-Fragen: `gpt-audit/previous-cycles.md`
