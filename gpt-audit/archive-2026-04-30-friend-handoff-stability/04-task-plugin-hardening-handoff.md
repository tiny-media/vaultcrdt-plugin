# External implementation task | Plugin hardening before friend handoff

You are Claude Code running as an external implementation worker for `vaultcrdt-plugin`.

## Goal

Implement the small plugin-side hardening items needed before Richard gives VaultCRDT to a friend for direct productive use on PC, Mac, iPad and Android.

## Read first

- `CLAUDE.md`
- `AGENTS.md`
- `.claude/rules/plugin-src.md`
- `gpt-audit/archive-2026-04-30-friend-handoff-stability/02-pre-handoff-plan.md`
- `gpt-audit/archive-2026-04-30-friend-handoff-stability/03-friend-target-profile.md`

Then inspect only the relevant plugin files/tests.

## Scope

Work only in the plugin repo. Do not edit `../vaultcrdt-server`.

Implement these items:

### 1. Normalize server URLs centrally

Problem: `https://host/` can become `https://host//auth/verify` and `wss://host//ws`.

Requirements:

- Central URL policy should return/use a canonical server base with no trailing slash.
- `toHttpBase()` and `toWsBase()` must not return a trailing slash.
- SetupModal must persist the normalized URL, not the raw input.
- Settings tab must persist the normalized URL, not the raw input.
- SyncEngine must continue to validate before starting.
- Keep the existing TLS/localhost/private-LAN policy intact.
- Add/adjust tests in `src/__tests__/url-policy.test.ts` and any affected setup/settings tests.

### 2. Make `doc_tombstoned` visible to the user

Problem: server refuses a push for a tombstoned document, but the plugin only logs a warning.

Minimal required behavior:

- Import/use Obsidian `Notice` in the relevant plugin code.
- On `doc_tombstoned`, show a clear user-visible Notice that the note was deleted on another device and local edits are not being accepted.
- Do not implement a large architecture change. If safe and small, create a local conflict copy from current editor content; otherwise leave that for a later task and mention it in the report.
- Add/adjust test coverage if the existing test harness makes it practical.

### 3. Make conflict copies visible

Problem: conflict files are a safety mechanism, but a normal user may not notice them.

Requirements:

- Wherever `sync-initial.ts` creates a conflict file, show a Notice with the conflict path.
- Keep messages concise and English in code/UI.
- If direct sync-aware conflict push is trivial and safe, implement it. If not, do not overreach; Notice is sufficient for this task.

### 4. Correct `.md`-only documentation

Problem: README says "Markdown notes and text files", but policy syncs only `.md`.

Requirements:

- Update `README.md` to say only Markdown (`.md`) notes are synchronized.
- Do not broaden sync policy.

## Guardrails

- Do not edit `wasm/`.
- Do not run `bun test`; use `bun run test`.
- Do not run `bun run wasm`.
- Do not deploy, release, tag, push or commit.
- No emojis in code/docs/log messages.
- Android mtime must not be used.
- Keep changes small and LLM-friendly.

## Checks

Run at least:

```bash
bunx tsc --noEmit
bun run test
bun run build
```

If time allows, also run:

```bash
bun run wasm:check
```

## Report

Return a German Markdown report to stdout with:

1. Files changed.
2. What was implemented.
3. Tests/checks run and their result.
4. Any skipped item and why.
5. Any remaining risk for the friend handoff.
