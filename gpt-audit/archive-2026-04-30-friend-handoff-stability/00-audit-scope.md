# Audit scope | friend handoff stability | 2026-04-30

## Goal

Richard wants to give VaultCRDT to a friend for real daily use. Before that, run independent external audits across the plugin and server, then use the findings to improve stability and prepare a short, precise handoff guide.

## Repositories

```text
/home/richard/projects/vaultcrdt-plugin/  # Obsidian plugin, TypeScript, Rust CRDT crates, committed WASM
/home/richard/projects/vaultcrdt-server/  # Rust/Axum sync server
```

## Current release state

- Plugin release live: `v0.3.0`
- Server release live on `home`: `vaultcrdt-server:0.2.6`
- Project status: pre-release; protocol and storage are not stable public APIs yet.
- Intended near-term audience: one trusted friend using the plugin in everyday Obsidian work, not public community release yet.

## Audit objective

Find the highest-value stability, data-loss, security, operational, and onboarding risks before this is handed to a friend.

Prioritize:

1. Anything that can lose, duplicate, resurrect, corrupt, or silently desync notes.
2. Anything that makes the friend's first setup or daily use likely to fail.
3. Anything that makes the current self-hosted server fragile in practice.
4. Anything visible in live server logs that indicates instability.
5. Small high-leverage fixes or checks before handoff.

Do not prioritize broad polish, public marketplace readiness, or large architecture changes unless they block safe daily use.

## Hard guardrails

- Read-only audit. Do not edit files.
- Do not deploy, restart services, create releases, tag, push, or run destructive commands.
- Do not run `bun test`; use only `bun run test` if tests are needed.
- Do not run `bun run wasm`; `wasm/` must never be edited manually.
- `bun run wasm:check` is allowed if useful.
- Android `mtime` must not be recommended for caching or skip logic.
- Keep `wasm-bindgen = "=0.2.117"` exactly pinned.
- Server work stays in `../vaultcrdt-server`; no server changes during this audit.
- If using `ssh home`, use read-only commands only. Do not print secrets. Redact tokens, passwords, admin tokens, API keys, and JWTs.

## Suggested sources

Plugin:

- `CLAUDE.md`, `AGENTS.md`, `next-session-handoff.md`, `README.md`, `package.json`, `manifest.json`
- `gpt-audit/previous-cycles.md`
- Relevant `src/`, `crates/`, `scripts/`, `docs/install-brat.md`
- Relevant tests

Server:

- `../vaultcrdt-server/CLAUDE.md`, `../vaultcrdt-server/AGENTS.md`, `../vaultcrdt-server/README.md`
- `../vaultcrdt-server/Cargo.toml`, `src/`, `migrations/`, `docker-compose.yml`, docs
- Relevant tests

Live server:

- Seed observation: `gpt-audit/archive-2026-04-30-friend-handoff-stability/live-server-observation.md`
- You may use `ssh home` for additional read-only inspection if needed. Known container: `vaultcrdt`.

## Useful checks if time allows

Plugin:

```bash
bun run test
bun run build
bun run wasm:check
```

Server:

```bash
cd ../vaultcrdt-server
cargo test
cargo clippy --all-targets -- -D warnings
```

Only run checks if they help the audit. Report if skipped.

## Output format

Write a German Markdown audit with:

1. Executive summary: safe / not safe / conditionally safe for friend handoff.
2. P0/P1/P2 findings table.
3. For each finding:
   - severity
   - affected repo/file/function or log evidence
   - why it matters for daily friend use
   - concrete recommended next action
   - whether it should block handoff
4. Positive signals worth preserving.
5. Suggested minimum pre-handoff checklist.
6. Explicitly list commands run and commands intentionally not run.

Avoid vague advice. Prefer evidence-backed, actionable findings.
