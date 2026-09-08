# Development

Source-checked: 2026-09-08. Workflow commands are not claims of passing checks.

## Build & test

Run from the repository root. Script names come from [package.json](../package.json).
For local dependency setup and frontend checks:

```sh
bun install
bun run test
bun run lint
bunx tsc --noEmit
bun run build
```

Use `bun run test`, not `bun test`: it invokes `vitest run`.

[CI](../.github/workflows/ci.yml) runs on main pushes and pull requests
and chains roughly: locked wasm-bindgen install → `bun install
--frozen-lockfile` → plugin tests → Rust workspace tests → wasm build →
wasm freshness check → tsc → build → a 2 MiB bundle-size gate on
`main.js`. The EXACT commands, versions and their order live in the
workflow file and change with it — copy from there, not from memory or
from this page. Two durable facts: the 2 MiB limit is a repository
regression gate (catches accidental loss of gzip embedding; not an
Obsidian store limit), and `bun run build` alone enforces neither the
size gate nor WASM freshness.

The workspace declares its Rust minimum in [Cargo.toml](../Cargo.toml);
the CI toolchain pin lives in the workflow. Local hygiene checks:

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

Whether clippy/fmt/lint run in CI vs. only locally vs. only in the
release workflow is workflow state — check the workflow files; do not
rely on this page for it.

### Rust → WASM → plugin

- `crates/vaultcrdt-core` supplies shared types and canonical blob path keys.
- `crates/vaultcrdt-crdt` wraps Loro documents, disk diffing and snapshots.
- `crates/vaultcrdt-wasm` depends on both and exposes the JS-facing bindings,
  BLAKE3 hashing and SVG sanitization.
- [scripts/build-wasm.sh](../scripts/build-wasm.sh), via `bun run wasm`,
  builds `vaultcrdt-wasm` for `wasm32-unknown-unknown` in release mode,
  then runs wasm-bindgen into `wasm/`. Never hand-edit generated artifacts.
- [scripts/check-wasm-fresh.sh](../scripts/check-wasm-fresh.sh), via
  `bun run wasm:check`, rebuilds into a temporary directory and compares
  the whole generated directory with `wasm/`; differences fail the check.
  To check committed artifacts for drift, run it before regenerating them.
  CI currently regenerates first, then compares the generated outputs.
- [esbuild.config.mjs](../esbuild.config.mjs) embeds the WASM bytes as
  gzip+base64 in `main.js`; no sibling WASM release asset is needed.

## Test suite map

Files below are in [src/__tests__/](../src/__tests__/), with `.test.ts` omitted.
The map describes assertions, not device-validation results.

- `blob-backfill`: attachment backfill, protocol gating and rename routing.
- `blob-downloader`: hydration, local preservation, receive caps and SVG sanitization.
- `blob-lane-session-death`: bounded feature probes, version scoping and blocked-upload retry.
- `blob-path-key`: real WASM key vectors and attachment eligibility.
- `blob-uploader`: upload lifecycle, catch-up, category paths and blob auth wake-up.
- `conflict-utils`: content hashes, version-vector relations and conflict names.
- `device-identity-reset`: peer regeneration and peer-bound state reset.
- `diagnostics`: diagnostic summaries and secret scrubbing.
- `divergence`: long-divergence convergence scenarios using the real CRDT.
- `document-manager`: lazy load, persistence, cleanup and resident-document operations.
- `editor-integration`: codepoint-to-UTF-16 offset conversion.
- `file-watcher`: loaded-document external-change scanning and stat skip heuristics.
- `inbox`: storage, reconciliation, startup discovery and notice throttling.
- `invite-redeem`: invite redemption and resulting identity state.
- `logger`: bounded issue ring behavior.
- `main-hydration-trigger`: mocked mobile metadata-cache hydration triggers.
- `main-vault-change`: mobile command registration and remote-write delete windows.
- `obsidian-sync`: raw path events, debounce, sweeps and toggle-on hydration ordering.
- `obsidian-toggle-gates`: effect-time hydrate, tombstone and upload gates; OFF→ON resume.
- `onboarding-invite`: onboarding and add-device UI.
- `path-policy`: note, attachment, configuration and Excalidraw eligibility.
- `promise-manager`: waiter resolution, rejection and cleanup.
- `push-handler`: debounce bounds, journal serialization, delete ack/resend and drawing holds.
- `quiet-mode-ui`: status badges, notice policy and status panel.
- `settings-identity`: category defaults, connection reset and device identity.
- `settings-tab`: settings UI structure.
- `setup-link`: setup URI parsing/creation, including invite tokens.
- `setup-modal`: setup dialog, prefilled joins and fresh-install state.
- `startup-dirty-tracker`: startup dirty-path tracking.
- `state-storage`: persisted sync state.
- `sync-engine-edge`: additional sync edge cases.
- `sync-engine`: auth, initial/broadcast sync, offline preservation, deletes, liveness, queues and errors.
- `url-policy`: server URL validation, normalization and local/private host policy.
- `user-facing-copy`: terminology, settings secret modes and badge copy.
- `uuid-compat`: UUID generation and older-WebView URL API compatibility.
- `wasm-bridge`: WASM initialization and document creation.
- Rust core: blob-key vectors, normalization collisions and structural rejection.
- Rust CRDT: document snapshots/deltas, disk diffs, and property-based
  convergence (ASCII test inputs; Unicode/normalisation vectors live in
  the core crate's path tests).
- Rust WASM: binding roundtrips, BLAKE3 vector and SVG sanitizer vectors.

[vitest.config.mts](../vitest.config.mts) uses Node, an Obsidian mock and a
window shim. Tests that exercise real WASM still use simulated host behavior.
CI does **not** test real desktop/mobile devices, filesystem notifications,
cloud-provider behavior, WebView lifecycle or Obsidian autosave timing.

## Compatibility & limits — 2026-09-08

Evidence here is code inspection and synthetic test coverage, not new device
measurements. Use one sync system for a vault.

**Parallel Syncthing, Dropbox or iCloud syncing is not supported.** There is
no integration protocol with these providers. Conflict files from either
system sync as ordinary notes when they pass `isSyncablePath`; no special
conflict-name exclusion exists in [src/path-policy.ts](../src/path-policy.ts).
Replacement events can produce delete/create or rename churn through
[src/main.ts](../src/main.ts). There is no iCloud placeholder detection.
These are compatibility limits, not a claim of a tested provider matrix.

**External editors, including VS Code and agents:** edits to closed,
syncable notes are reliably ingested while Obsidian runs and sync is ready:
the `modify` handler reads disk and calls `onFileChangedImmediate`.
Startup suppression and remote-write echo gates still apply.
Open editor buffers are authoritative: the handler ignores disk modifications
for an open note, and autosave can override the external edit.
Anchors: [src/main.ts](../src/main.ts) vault event handlers and
[src/editor-integration.ts](../src/editor-integration.ts) `readCurrentContent`/`writeToVault`.

Edits made while Obsidian is closed are not guaranteed immediate upload on
restart. `initial-sync.vv-clean-skip` in [src/sync-initial.ts](../src/sync-initial.ts)
does not re-read every file; [src/file-watcher.ts](../src/file-watcher.ts)
only scans resident documents. For a clean-skipped, still-closed note, the
preservation path is a later broadcast: `onDeltaBroadcast` in
[src/sync-engine.ts](../src/sync-engine.ts) compares disk with pre-import
CRDT text and preserves unseen text as a conflict copy plus inbox entry.
This is preservation, not automatic incorporation into the original note.
`sync-engine.test.ts` pins “broadcast preserves unseen disk text”.

## Release

The release guard requires **tag == manifest.json version == package.json
version**, as exact strings. Plugin tags have **no `v` prefix** (store rule).
Keep `versions.json` aligned with the supported Obsidian minimum as well.

The [release workflow](../.github/workflows/release.yml) checks out the tag,
runs tests, Rust tests, WASM build/freshness, typecheck, lint, build and the
same 2 MiB gate. It builds assets from that tag, not from local leftovers.
The release contains exactly `main.js`, `manifest.json` and `styles.css`;
the workflow prunes unexpected assets.

Maintain [CHANGELOG.md](../CHANGELOG.md): put notable changes under
`Unreleased`, then move them into a dated version section before tagging.
Use Keep a Changelog categories and Semantic Versioning; distinguish shipped
fixes from deferred work. Releasing is a separate maintainer action.

## Security scanning

[security.yml](../.github/workflows/security.yml) configures CodeQL for
JavaScript/TypeScript and Rust (`security-extended`, build mode `none`), OSV
lockfile scanning with SARIF upload, `bun audit`, and
`cargo audit --file Cargo.lock`. Scorecard runs only on main pushes and the
schedule (default branch), not tags, pull requests or manual dispatch.

Only the OSV scan step is advisory-mode (`continue-on-error: true`);
bun/cargo audit are not. A green workflow is not evidence of zero alerts.
See [security-review-2026-09-08.md](security-review-2026-09-08.md) for current
dispositions, including the later dependency acceptance and alert adjudication
sections; early findings there may be superseded by later dispositions.

## Documentation provenance

Durable docs retain the result, date and a code/test/measurement anchor.
State whether evidence is code inspection, a synthetic test or a device
measurement; mark unimplemented decisions explicitly. Who or what produced
a measurement belongs in its session record, not in durable documentation.
Keep unresolved evidence gaps as review hooks rather than upgrading them to
verified facts. Standing architecture choices live in [decisions/](decisions/).

Doc ownership: `docs/architecture.md` and the ADRs own technical
contracts; the named risk register (once it exists) owns risk decisions;
`dev/next.md` owns current work; dated reviews are historical evidence,
not growing session logs. Their existing crew provenance is a historical
exception and stays; new crew/provider/deployment details go to session
records only.
