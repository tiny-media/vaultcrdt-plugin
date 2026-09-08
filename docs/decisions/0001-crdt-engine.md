# 0001 — Loro CRDT for notes

Status: standing, implemented. Source-checked: 2026-09-08.

## Context

Notes can be edited concurrently and while disconnected. Text synchronization
needs shared operation history rather than whole-file last-writer-wins alone.
The plugin must bridge filesystem text, open editor buffers and remote state.

## Decision

Use Loro for note documents, pinned to `=1.16.0` in
[Cargo.toml](../../Cargo.toml). The native wrapper lives in
[crates/vaultcrdt-crdt/src/document.rs](../../crates/vaultcrdt-crdt/src/document.rs);
`SyncDocument` exposes text, version vectors, snapshots and incremental imports.
[diffing.rs](../../crates/vaultcrdt-crdt/src/diffing.rs) converts disk edits
into CRDT operations. The WASM crate exposes these operations to TypeScript.

The synchronization model includes server-side snapshot storage. The client
sends snapshots for creation and consumes snapshots during initial sync;
see [src/push-handler.ts](../../src/push-handler.ts) `pushDocCreate` and
[src/sync-initial.ts](../../src/sync-initial.ts). Local persisted CRDT state
is managed by [src/document-manager.ts](../../src/document-manager.ts).

## Consequences

- Shared-history edits can merge; loss of shared history and some concurrent
  whole-file edits still require conflict preservation rather than blind merge.
  See [src/__tests__/divergence.test.ts](../../src/__tests__/divergence.test.ts)
  and the disjoint-history cases in `src/__tests__/sync-engine.test.ts`.
- Server-side snapshots and plaintext paths are not end-to-end encrypted;
  this is a trusted-operator model, not confidential storage from the operator.
- Loro carries `im` and its `bitmaps`/`sized-chunks` dependencies in
  [Cargo.lock](../../Cargo.lock). Their soundness and maintenance advisories
  have no fixed upstream version as of 2026-09-08, per the dependency triage in
  [the security review](../security-review-2026-09-08.md).
  Status: PROVISIONAL acceptance (recommended 2026-09-08, delegated
  review) — Richard's explicit confirmation and the risk-register
  entries are pending; conditions: re-review before store release, at
  every Loro release, and no later than 2026-12-08.
- Loro upgrades must stay in lockstep with the server and repeat convergence,
  snapshot compatibility, WASM freshness and bundle-size checks.

## Review hooks

The server repository is not in this checkout. Client snapshot exchange and
native server-merge simulations are visible here; actual server persistence
must be rechecked against its document handlers and database implementation.
The dated upstream advisory status is anchored to the security review, not a
fresh registry query performed for this ADR.
