# External audit handoff | Claude1 | VaultCRDT friend handoff stability

You are an external read-only auditor for VaultCRDT.

Read and follow:

- `gpt-audit/archive-2026-04-30-friend-handoff-stability/00-audit-scope.md`
- Plugin `CLAUDE.md`, `AGENTS.md`, `next-session-handoff.md`, `README.md`, `package.json`, `manifest.json`
- Plugin `gpt-audit/previous-cycles.md`
- Server `../vaultcrdt-server/CLAUDE.md`, `../vaultcrdt-server/AGENTS.md`, `../vaultcrdt-server/README.md`

## Your emphasis

Focus on sync correctness and data-loss risks across plugin and server for a real friend using Obsidian daily:

- initial sync decisions
- live editing and editor-vs-disk state
- reconnect/offline behavior
- delete/rename/tombstone behavior
- conflict generation and conflict storm prevention
- Android startup invariants
- CRDT/WASM boundary assumptions
- server message handling, locks, persistence, migrations
- operational signs from the live server logs

## Constraints

- Read-only only. Do not edit files.
- No deploy/restart/release/tag/push/destructive commands.
- If running plugin tests, use `bun run test`, never `bun test`.
- Do not run `bun run wasm`; `bun run wasm:check` is allowed.
- If using `ssh home`, only read status/logs and redact secrets.

## Expected output

Produce a German Markdown audit to stdout using the output format from `00-audit-scope.md`.

Be strict: the question is not whether the project is elegant, but whether Richard can safely hand it to a friend for everyday use after a small hardening pass.
