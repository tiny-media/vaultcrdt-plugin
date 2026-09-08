# 0005 — E2EE v2 remains parked

Status: current plaintext model implemented; v2 wire direction decided, not built.
Date: 2026-09-08.

## Context

E2EE is **not built**. The server can read note text and attachment bytes,
including plaintext paths. The current deployment assumes a trusted operator;
HTTPS protects transport, not content from that operator.

The client sends Loro snapshots/deltas in
[src/push-handler.ts](../../src/push-handler.ts) and raw blob bodies in
[src/blob-uploader.ts](../../src/blob-uploader.ts), without an E2EE envelope.
The native document wrapper exposes plaintext via `get_text` in
[document.rs](../../crates/vaultcrdt-crdt/src/document.rs).
[README.md](../../README.md) states the trusted-operator model explicitly.

## Decision

Keep E2EE implementation parked. The following six wire rules are the standing
v2 protocol direction: **decided, not built**. Building E2EE requires a separate
decision; none of these rules describes a current feature.

Verbatim protocol contract:

> (1) envelope: random 256-bit DEK wrapped by a passphrase KEK — the passphrase is never itself the key; (2) keyId in every container header from day one; (3) keyring as a reserved document (.vaultcrdt/keyring): unencrypted non-%ELO document with wrapped DEKs, last-writer-wins by signed field, not Loro merge; (4) rotation = new keyId + fresh snapshot; clients stop on unknown keyIds, never silently skip; (5) recovery key = second wrap of the DEK; (6) doc_uuid obfuscation via an HMAC key derived from the DEK (HKDF, fixed info string) — affects server logs/diagnostics that today show plaintext paths.

## Consequences

- Do not advertise passphrase encryption, recovery keys, key rotation or
  encrypted server storage as available today.
- Future work must preserve envelope/key-ID compatibility from its first
  container format rather than adding identifiers only when rotation ships.
- The reserved keyring requires explicit routing and signed-field conflict
  semantics; it must not silently enter the current Markdown/Loro lane.
- Unknown key IDs must become explicit stop conditions, not apparent success
  with missing documents.
- Obfuscated document identifiers will change diagnostics and server path
  visibility. Existing plaintext-path tooling cannot be assumed compatible.
- The operator-trust model remains until a separately reviewed implementation
  and migration are delivered. Authentication and HTTPS are not substitutes
  for the parked E2EE design.

## Review hooks

There is no implementation anchor for the six future rules; this ADR preserves
the decided protocol contract. Algorithms for wrapping/signing, KDF parameters,
the literal HKDF info string, container encoding and migration behavior still
need specification and tests in the separate implementation decision. Do not
invent those details or infer an interoperable encrypted format from this page.
