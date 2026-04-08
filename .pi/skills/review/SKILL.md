---
name: review
description: Read-only Review der geaenderten Dateien gegen CLAUDE.md Critical Rules und .claude/rules/*. Use when the user asks to review, audit, or check changes.
---

# Review

Read-only. Lies Diffs, keine Aenderungen.

## Schritte

1. `git diff --name-only HEAD~1` — oder bei uncommitteten Aenderungen `git diff --name-only`
2. Fuer jeden betroffenen Bereich die relevante Rule lesen:
   - `crates/**` → `.claude/rules/rust-crates.md`
   - `wasm/**`, `scripts/build-wasm.sh`, `scripts/check-wasm-fresh.sh` → `.claude/rules/wasm-build.md`
   - `src/**` → `.claude/rules/plugin-src.md`
   - `gpt-audit/**` → `.claude/rules/gpt-audit.md`
3. `CLAUDE.md` Critical Rules mitnehmen
4. Geaenderte Dateien lesen und pruefen

## Checkliste

**Universell**
- Emojis in Code/Docs?
- Hardcoded Secrets?
- Dateien unverhaeltnismaessig gross oder fragmentiert?
- Toter Code / Deprecation-Stubs / Backwards-Compat-Hacks?

**Rust**
- `unwrap()` / `expect()` ohne Kommentar?
- `wasm-bindgen`-Pin veraendert?
- Workspace-Abhaengigkeits-Richtung respektiert?

**TypeScript**
- `bun test` statt `bun run test` irgendwo?
- Android mtime fuer Caching?
- Obsidian interne Felder statt oeffentlicher API?

**Docs / Handoff**
- Relative statt absolute Daten?
- Audit-Findings in CLAUDE.md inline?

## Output

- Dateien + Befunde mit `datei:zeile`
- Konkrete Fix-Vorschlaege (umsetzbar)
- Warnungen separat von Blockern
- "Keine Probleme gefunden" wenn alles passt

Keine Lobpreisungen, keine Zusammenfassung am Ende.
