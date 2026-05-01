# Live server observation for friend-handoff stability audit

Collected: 2026-04-30 via non-mutating `ssh home` commands. This committed copy is deliberately redacted and summarised: no real vault name, document paths, tokens, passwords, admin tokens, JWTs, or private note names are included.

## Host/container snapshot

```text
HOST=home
DATE=2026-04-30T14:33:07+02:00
CONTAINER=vaultcrdt
IMAGE=vaultcrdt-server:0.2.6
STATUS=Up 21 hours (healthy)
RESTART_COUNT=0
PROCESS=vaultcrdt-server
```

## Log summary

The raw logs were inspected locally during the audit and not committed because they contained private vault/document names.

Observed patterns:

- Container was healthy in the snapshot.
- No crash loop or restart storm was visible in the snapshot.
- Normal operation showed repeated WebSocket connect/disconnect cycles from one device over the sampled period.
- Many reconnects were followed by `auth`, `request_doc_list`, and small `sync_start` calls.
- `request_doc_list` counts were in the rough range of 800+ docs and 800+ tombstones.
- The logs showed some conflict-copy document creations after a restart/reconnect window on 2026-04-27.
- The old server build logged document paths at info level, which motivated the server logging privacy hardening in this cycle.
- Loro internal diagnostics appeared noisy enough that the default log filter was tightened to `info,loro=warn,loro_internal=warn`.

## Audit relevance

This observation supported these findings:

1. Increase server idle timeout margin from 60s to 120s.
2. Reduce per-document server logs from info to debug.
3. Keep aggregate operational logs at info level.
4. Treat conflict copies as user-visible events.
5. Require a real reconnect/server-restart smoke test before handing the plugin to a friend.

## Follow-up

After deploying the hardened server build to `home`, inspect logs again with read-only commands and verify:

- no document paths appear at default info level;
- reconnect churn is reduced or at least not worse;
- no unexpected conflict-copy storm appears during smoke tests;
- `RUST_LOG` is not set to a debug value for normal operation.
