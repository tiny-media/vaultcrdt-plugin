# External audit handoff | Pi gpt-5.5 xhigh | VaultCRDT friend handoff readiness

You are an external read-only auditor for VaultCRDT.

Read and follow:

- `gpt-audit/archive-2026-04-30-friend-handoff-stability/00-audit-scope.md`
- Plugin `CLAUDE.md`, `AGENTS.md`, `next-session-handoff.md`, `README.md`, `package.json`, `manifest.json`
- Plugin `gpt-audit/previous-cycles.md`
- Server `../vaultcrdt-server/CLAUDE.md`, `../vaultcrdt-server/AGENTS.md`, `../vaultcrdt-server/README.md`

## Your emphasis

Focus on handoff readiness, practical stability, server operations, and user-facing failure modes:

- first-time setup journey for a friend
- BRAT/manual install docs and setup modal assumptions
- credential/server URL validation and error messages
- backup/rollback expectations before first sync
- server health, restart behavior, DB/tombstone growth, logs, observability
- auth/TLS/self-hosting risks for a small private deployment
- tests/build/package/release consistency
- whether any minimal pre-handoff smoke tests are missing

Also audit sync correctness enough to flag handoff blockers, but do not duplicate old findings from `previous-cycles.md` unless they remain materially unresolved.

## Constraints

- Read-only only. Do not edit files.
- No deploy/restart/release/tag/push/destructive commands.
- If running plugin tests, use `bun run test`, never `bun test`.
- Do not run `bun run wasm`; `bun run wasm:check` is allowed.
- If using `ssh home`, only read status/logs and redact secrets.

## Expected output

Produce a German Markdown audit to stdout using the output format from `00-audit-scope.md`.

Be practical: classify what blocks giving this to one trusted friend, what can be fixed after handoff, and what belongs only to a later public release.
