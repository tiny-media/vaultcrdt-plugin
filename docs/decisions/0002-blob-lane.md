# 0002 — Separate content-addressed blob lane

Status: standing, implemented. Source-checked: 2026-09-08.

## Context

Images, PDFs and audio are not mergeable note text. Putting their bytes into
note CRDT history would couple attachment size and transfer retries to text
synchronization. Configuration files also need whole-file transfer, not Loro
text merging.

## Decision

Use content-addressed BLAKE3 blobs over a separate HTTP lane. A path reference
identifies the current blob; a blob hash identifies bytes, not a filename.
[BlobUploader](../../src/blob-uploader.ts) uploads through
`/vault/blobs/uploads` before publishing a reference through `/vault/blob-paths`.
[BlobDownloader](../../src/blob-downloader.ts) fetches `/vault/blobs/{hash}`,
checks BLAKE3, then writes local bytes.

Upload admission and per-vault blob quota are server-side responsibilities.
The client handles quota responses; the quota is not a total budget covering
note snapshots, metadata or all received files.

Client receive gates are implemented: downloaded size must match the indexed
size and stay within `AUDIO_CAP` (25 MiB), across range and full-body paths.
SVG bytes are sanitized after transport-hash verification and before write
or conflict-copy effects; the index records the sanitized local baseline.
Upload class caps are 10 MiB for images/PDFs, 25 MiB for audio and 2 MiB for
configuration files ([src/path-policy.ts](../../src/path-policy.ts)). Do not
confuse those class caps with the downloader's largest-class bound.

The authoritative `.obsidian` category gate is `is_obsidian_allowlisted_key`
inside Rust's [blob_path_key](../../crates/vaultcrdt-core/src/blob_path.rs),
applied to the final NFC → full-casefold → NFC key. TypeScript category
classification is a routing/toggle gate, not a replacement for that allowlist.

## Consequences

- Identical content can be deduplicated independently of path changes.
- Note sync and blob hydration have separate scheduling and failure states.
- Receiver sanitization does not rely on a cooperative sender or server.
- Transport may buffer an oversized response before the client rejects it;
  the cap is not a guarantee of bounded transport memory. No cumulative
  receive budget is implemented.
- Path-key and sanitizer behavior have shared vector fixtures and real-WASM
  tests: `src/__tests__/blob-path-key.test.ts`, `blob-downloader.test.ts`,
  `docs/blob-path-key-vectors.json` and `docs/svg-sanitize-vectors.json`.

## Review hooks

Server admission/quota code is outside this checkout. Recheck its upload
reservation, expiry and finalization logic before claiming atomic quota
accounting. The [security review](../security-review-2026-09-08.md) records
bounded admission overshoot and remaining budget/path-binding issues; this
ADR does not upgrade those server claims to locally verified guarantees.
