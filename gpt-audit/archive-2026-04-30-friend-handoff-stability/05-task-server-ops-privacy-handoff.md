# External implementation task | Server ops/privacy hardening before friend handoff

You are Claude Code running as an external implementation worker for `vaultcrdt-server` from the sibling repo.

## Goal

Implement small server-side ops/privacy/doc hardening items needed before Richard gives VaultCRDT to a friend for direct productive use on Richards server.

## Working directory

Start in `/home/richard/projects/vaultcrdt-plugin`, but server changes belong in:

```text
/home/richard/projects/vaultcrdt-server
```

Do not edit plugin source files except the audit report/handoff files if absolutely necessary. Prefer stdout report only.

## Read first

Plugin-side context:

- `CLAUDE.md`
- `AGENTS.md`
- `gpt-audit/archive-2026-04-30-friend-handoff-stability/02-pre-handoff-plan.md`
- `gpt-audit/archive-2026-04-30-friend-handoff-stability/03-friend-target-profile.md`
- `gpt-audit/archive-2026-04-30-friend-handoff-stability/live-server-observation.md`

Server-side context:

- `../vaultcrdt-server/CLAUDE.md`
- `../vaultcrdt-server/AGENTS.md`
- `../vaultcrdt-server/README.md`
- `../vaultcrdt-server/Cargo.toml`

Then inspect relevant server files/tests.

## Scope

Work only in `../vaultcrdt-server` for code/docs. No deploy/restart/release/tag/push/commit.

Implement these items:

### 1. WS idle timeout margin

Problem: code comment says 5 minutes, code uses 60 seconds, plugin heartbeat is 30 seconds, live logs show reconnect churn.

Requirements:

- Make the code/comment consistent.
- Prefer a 120 second idle timeout unless you find a strong reason not to.
- Keep behavior simple and testable.

### 2. Privacy-friendly default logging

Problem: live logs currently include document paths on normal Info-level logs. Richard wants to host for a friend without seeing the vault in everyday operations.

Requirements:

- Move normal per-document path logs from `info!` to `debug!` where practical.
- Keep aggregate operational logs at `info!`, e.g. request_doc_list counts, server start, maintenance, connection/disconnection.
- Avoid logging document paths on refused tombstone/create/push at info level; use debug or a sanitized aggregate message.
- Add an env-filter based subscriber if needed so dependency noise such as Loro internals can be suppressed by default.
- Preserve warnings/errors that are needed for operations, but avoid leaking document paths there unless essential for debugging.
- If adding `EnvFilter` requires a `tracing-subscriber` feature, update `Cargo.toml` intentionally.

### 3. Tombstone retention docs/env

Problem: `VAULTCRDT_TOMBSTONE_DAYS` matters for long-offline devices but is invisible in `.env.example` and incomplete in README.

Requirements:

- Add `VAULTCRDT_TOMBSTONE_DAYS` to `.env.example` with friend-use guidance.
- Add it to README environment-variable table.
- Recommend 365 days for small private friend deployments unless there is a reason not to.

### 4. Server README/version/backup/restart docs

Requirements:

- Fix README status version to match `Cargo.toml` (`0.2.6`) unless you also bump version for code changes. Do not create a release.
- Add a concise Backup/Restore section for SQLite in Docker Compose setup.
- Mention that Richard/server operator can technically access data because there is no E2E encryption, and logs are minimized by default but support/debug may expose document names.
- Add or consider `restart: unless-stopped` in `docker-compose.yml` if appropriate.

## Guardrails

- No deploy/restart/service changes.
- No `ssh home` unless you only run read-only status/log commands and redact secrets. This task likely does not need SSH.
- Do not print secrets.
- Do not commit/push/tag/release.
- Keep authentication errors generic.
- Keep tombstones sticky until retention expires.
- No emojis in code/docs/logs.

## Checks

Run in `../vaultcrdt-server`:

```bash
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test --workspace
```

## Report

Return a German Markdown report to stdout with:

1. Files changed.
2. What was implemented.
3. Tests/checks run and their result.
4. Any skipped item and why.
5. Any remaining risk for the friend handoff.
