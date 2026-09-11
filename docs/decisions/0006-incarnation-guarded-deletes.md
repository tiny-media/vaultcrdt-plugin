# 0006 — Incarnation-guarded document deletes

Status: implemented (server b63efc4, plugin 4892bb4, 2026-09-11; full
test matrices green, every regression red-falsified). Design counter-read
through five rounds (2026-09-11; v1–v4 BLOCK, v5 GO-WITH-EDITS with the
final recreation-invalidation edit folded). Full design:
[dev/work/delete-incarnation-brief-2026-09-11.md](../../dev/work/delete-incarnation-brief-2026-09-11.md)
(untracked working file; this ADR carries the durable summary).

## Context

`DocDelete` on the wire carries only `doc_uuid` and `peer_id`. A delete
that is retried after the ack was lost — or sent late after a
recreation — cannot be distinguished from a fresh delete of the CURRENT
document, so a stale delete destroys a newer recreation at the same
path (consult 2026-09-10, server finding 2; the plugin already guards
remote ATTACHMENT deletes identity-checked, but note deletes had no
server-side equivalent).

## Decision

Deletes become incarnation-guarded through a server-allocated,
vault-wide durable token:

- **Allocation.** A per-vault counter (`vault_incarnation`) hands out
  monotonic tokens inside the same transaction that establishes a live
  document row. Every absent→live transition allocates: first create,
  tombstone-replacing create, the both-rows merge (explicit
  conservative rotation), and absent→live `sync_push`. Ordinary
  updates keep the token. Tombstone expiry can never recycle a token.
  Token 0 is reserved to mean "expect absence".
- **Guarded delete.** `DocDelete` gains `expected_incarnation`
  (match → delete; mismatch or 0-vs-live → `DeleteRejected` with no
  mutation and no broadcast; `None` → today's unconditional delete for
  legacy clients). A rejected delete means "the server holds a
  different incarnation than this delete attests".
- **Delete proof.** A delete may carry only (i) a token the client
  OWNS — granted by its own accepted write result or by a completed
  adoption — or (ii) a token freshly resolved for this intent via
  `SyncStart` (absence resolves to 0). Observations (DocList,
  broadcasts) never authorize a delete directly; caches are
  optimizations, correctness never depends on them.
- **Correlation.** Write requests carry an echoed `request_id`
  (`doc_create`, `sync_push`, `doc_delete`); `Ack`/`Error`/
  `DeleteRejected` echo it back, so the client can bind an
  incarnation grant to the write that earned it. `AuthOk` advertises
  the `delete_incarnation` capability; clients degrade to legacy
  unconditional deletes (with a warning) on incapable servers.
- **Intent discipline.** Delete intents are journal entries with an
  `intent_id`, durable BEFORE any cleanup or send; the resolved token
  and a send-attempt mark are pinned durably before the first send;
  attempted intents never re-resolve or replay (the existing
  lost-delete-over-destroyed-recreation trade-off). The exact intent
  must still own the entry after every awaited step, and an accepted
  local recreation invalidates the pending intent before any
  content-equality shortcut. `DeleteRejected` retires only the exact
  matching `intent_id`.

Deployment is additive and version-safe in both directions; full
protection requires new server and new plugin.

## Consequences

- Stale deletes can no longer destroy a recreation, including
  same-text and empty-note recreations (the case that defeated a
  content-hash variant considered and rejected in round 1).
- The server schema gains `documents.incarnation`,
  `tombstones.incarnation` and `vault_incarnation` (append-only
  migration; existing rows backfill to 1, counter seeds to 2 — the
  baseline is per-(vault, doc), not vault-unique history recovery).
- The plugin gains a persisted ownership cache, intent fencing in the
  delete journal, and request-id correlation in the broker.
- Deliberately out of scope (lifecycle work, separate): push
  cancellation during deletes; in-place recovery from
  `DeleteRejected` beyond retire-and-reclassify; the residual risk on
  incarnation-blind (old-server) connections; unseen concurrent
  remote edits remain superseded by a delete (unchanged CRDT
  semantics).
