# 0003 — Preserve edits across deletion

Status: standing, implemented. Source-checked: 2026-09-08.

## Context

A remote delete may arrive while another device has offline edits, queued
changes or a recreated document under the same path. Replaying an old delete
or trusting an obsolete tombstone can remove work that was never synchronized.

## Decision

Use tombstones with a content hash, persistent delete intents with ack-memory,
and a liveness guard before renaming a file after a tombstone refusal.

[src/push-handler.ts](../../src/push-handler.ts) keeps a delete journal with
`acked` state. Only unacked deletes are eligible for resend; local recreations
are not resent as deletes. “Acked” intentionally includes successful emission
on an open socket, not just a server confirmation. Reconciliation with the
server document list prevents replay over a peer's resurrection.

[src/sync-initial.ts](../../src/sync-initial.ts) and
[src/sync-engine.ts](../../src/sync-engine.ts) keep local content when pending
or sent-unacknowledged edits exist, or when local text differs from the
tombstone hash. `fnv1aHash64` in
[src/conflict-utils.ts](../../src/conflict-utils.ts) is a 64-bit,
non-cryptographic content discriminator, not an authentication mechanism.
Legacy missing-hash cases use the conservative CRDT comparison path.

`handleDocTombstoned` calls `tombstoneRefusalIsStale` before renaming:
a live snapshot keeps the path and triggers resend; an unknown answer or
timeout defers rename; a definitive no-live response permits preservation
under a remote-deleted filename. Initial sync also recognizes a live row
coexisting with a tombstone rather than treating that path as deleted-only.

## Consequences

- Offline edits of deleted documents are preserved rather than blindly
  trashed: local content can be kept/recreated or moved to a discoverable
  preservation file. Preservation is not a promise to retain the old identity.
- An unchanged local copy can follow the remote deletion into trash.
- Ack-at-send favors avoiding destructive replay: a lost delete may leave a
  restored file that the user must delete again.
- Liveness probing is bounded; uncertainty is not deletion confirmation.
- Tests anchor the behavior in
  [sync-engine.test.ts](../../src/__tests__/sync-engine.test.ts): initial
  tombstones, non-resident keep-guards, sent-but-unacked pushes and
  `doc_tombstoned`; [push-handler.test.ts](../../src/__tests__/push-handler.test.ts)
  covers delete journal ack/resend. These are synthetic, not device tests.

## Review hooks

Server tombstone storage, hash parity and retention/GC must be checked in the
server repository. The [security review](../security-review-2026-09-08.md)
also records unresolved tombstone-rename path-policy and conflict-copy sink
issues; liveness protection is not a claim that every rename sink is hardened.
