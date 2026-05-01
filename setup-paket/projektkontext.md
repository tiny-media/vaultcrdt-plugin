# Projektkontext | vaultcrdt-plugin

Setup-Version: v0.3-draft
Stand: 2026-04-30

## Projektziel

`vaultcrdt-plugin` ist die Obsidian-Plugin-Seite von **VaultCRDT**: ein selbst gehosteter Sync fuer Obsidian-Vaults ueber Loro-CRDTs.

Das Projekt besteht praktisch aus zwei Repos:

```text
/home/richard/projects/vaultcrdt-plugin/  # Plugin, TypeScript, Rust-CRDT-Crates, WASM
/home/richard/projects/vaultcrdt-server/  # Rust/Axum Sync-Server
```

Diese Projektleiterin steuert vom **Plugin-Repo** aus. Der Server bleibt ein eigenes Repo und eine eigene technische SSOT, wird aber bei plugin-/protokoll-/release-relevanten Fragen gezielt mit betrachtet.

## Projektform

v0.3-Einordnung:

```text
Overlay / technisches Hub-Projekt
```

Regel:

```text
setup-paket/ = Steuer- und Re-Entry-Schicht
technische SSOT = README.md, CLAUDE.md, AGENTS.md, next-session-handoff.md, package.json, manifest.json, docs/, src/, crates/, wasm/, .agent-memory/
Server-SSOT = ../vaultcrdt-server/README.md und dortige Projektartefakte, nur bei konkretem Bedarf
```

## Aktueller technischer Stand

- Plugin-Release live: `v0.3.0`.
- Projekt ist Pre-Release; Protokoll und Storage-Format koennen sich noch aendern.
- Plugin ist ein Rust + TypeScript Hybrid:
  - TypeScript/Obsidian-Integration in `src/`
  - Rust-CRDT-Crates in `crates/`
  - committed WASM-Artefakte in `wasm/`
- Der Server liegt im Schwesterrepo `../vaultcrdt-server` und ist die kanonische Rust/Axum-Server-Seite.
- Die alten Monorepo-/Split-Spuren sind retired; gemeinsame CRDT-Crates und WASM-Build leben im Plugin-Repo.

## Wichtige Invariants

- Test-Befehl: `bun run test`; nicht Buns eingebauten Test-Runner verwenden.
- Build: `bun run build`.
- WASM nur ueber `bun run wasm` neu bauen; `wasm/` nie von Hand editieren.
- `bun run wasm:check` prueft WASM-Drift.
- `wasm-bindgen` ist auf `=0.2.117` gepinnt; CLI-Version muss matchen.
- Rust Edition 2024, MSRV 1.94.
- Android mtime ist unzuverlaessig und darf nicht fuer Caching oder Skip-Logik genutzt werden.
- Keine Emojis in Code, Commits, Docs oder Log-Messages.
- Single user / keine Backwards-Compatibility-Pflicht: toter Code darf entfernt werden, keine Deprecation-Stubs noetig.

## Bestehendes Agenten-Setup

Vor v0.3 war bereits ein starkes projektlokales Agenten-Setup vorhanden:

- `CLAUDE.md` als technische Agenten-Orientierung
- `AGENTS.md` mit Memory-Hinweisen
- `.claude/` mit Commands, Rules und Reviewer-Agent
- `.pi/` mit Skills und `anchor-return`; die fruehere projektspezifische Invariant-Extension ist nicht mehr aktiv
- `.agent-memory/` mit Link auf `../vaultcrdt-server`

v0.3 ergaenzt dies als schlanke Steuer-/Re-Entry-Schicht und ersetzt nicht die technische Projektwahrheit.

## v0.3-Setup-Stand

Eingerichtet:

- `setup-paket/arbeitsmodell.md`
- `setup-paket/stacks/context-control.md`
- `setup-paket/stacks/memory.md`
- `setup-paket/stacks/search.md`
- `setup-paket/stacks/handoff.md`
- `setup-paket/stacks/task-delegation.md`
- `setup-paket/stacks/testing.md`
- `setup-paket/guides/pi-anker-return-workflow.md`
- `setup-paket/guides/externe-task-runs-claude-pi.md`
- `setup-paket/guides/e2e-test-workflow-fuer-coding-projekte.md`
- `setup-paket/templates/`
- `setup-paket/assets/pi-extensions/anchor-return.ts`
- `.pi/extensions/anchor-return/index.ts`

Pi-Settings enthalten `anchor-return` als aktive v0.3-Context-Control-Extension.

## Aktive oder naheliegende Stränge

Noch nicht automatisch als AGs eroeffnen; nur bei konkretem Bedarf:

1. **Release / Community-Readiness**
   - Setup-Journey vom Install bis zum ersten erfolgreichen Sync pruefen.
   - Onboarding, BRAT-Install, Self-Hosting-Erklaerung und Troubleshooting schaerfen.

2. **Android Startup / Codequalitaet**
   - Startup-Fixes sind wirksam, aber spaeter gezielt auf Vereinfachung, Benennung und uebrig gebliebene Debug-Logik pruefen.

3. **Langzeitbetrieb / Retention / Storage**
   - Wachstum von Server-DB, Tombstones, VV-Caches und Plugin-State unter realistischem Churn auditieren.

4. **Server-Integration**
   - Nur bei konkreten Protokoll-, Deploy-, Auth- oder Betriebsfragen das Schwesterrepo `../vaultcrdt-server` gezielt nachladen.

## Re-Entry-Regel

Eine frische Projektleiterin liest zuerst nur:

1. `setup-paket/projektkontext.md`
2. `AGENTS.md`
3. `CLAUDE.md`
4. `next-session-handoff.md`
5. `README.md`
6. `package.json`
7. `manifest.json`

Danach stoppen und synthetisieren.

Nicht automatisch lesen:

- `src/`
- `crates/`
- `wasm/`
- `.claude/rules/*`
- `gpt-audit/archive-*`
- `../vaultcrdt-server/*`

Diese Quellen nur gezielt nachladen, wenn ein konkreter Task oder eine konkrete Entscheidung das braucht.

## Context-Control

Bei mehr als wenigen weiteren Dateien gilt:

```text
/anchor <name>
# explorieren
/distill <name> --to setup-paket/task-rueckmeldungen/<name>-rueckmeldung.md
/return <name> --with setup-paket/task-rueckmeldungen/<name>-rueckmeldung.md
```

Alternativ AG oder Task vorschlagen, wenn der Strang laenger wird.

## Memory

- Durable Memory lebt in `.agent-memory/`.
- Das Plugin-Memory linkt `../vaultcrdt-server`.
- Nach Memory-Aenderungen:

```bash
memory-vault reindex
memory-vault generate --sync-context-files
```

Wenn Server-Memory geaendert wurde, danach im Plugin-Repo ebenfalls reindex/generate laufen lassen, damit die verlinkte Sicht aktuell ist.

## Nächster sinnvoller Schritt

Nicht weiter Setup feilen.

Naheliegend ist ein frischer Re-Entry-Test:

```text
vaultcrdt-plugin | Projektleiterin
```

Danach als echte Arbeit zuerst einen kleinen, klar begrenzten Strang waehlen, z. B.:

- Community-Readiness / erster erfolgreicher Sync
- Android-Startup-Codequalitaetsreview
- Langzeitbetrieb-/Retention-Audit

## Risiken

- Die neue v0.3-Schicht darf das vorhandene starke technische Agenten-Setup nicht ersetzen oder verdoppeln.
- Die Projektleiterin darf nicht blind in `src/`, `crates/`, `wasm/` oder Server-Code eintauchen.
- Server-Arbeit darf nicht versehentlich aus dem Plugin-Kontext heraus ohne klares Handoff geaendert werden.
- `wasm/` und Rust-Crates sind besonders guardrail-sensibel.
