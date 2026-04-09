# Memory Vault Digest

## Decisions
- Keep startup dirty tracking device-local — why: Dirty state is device-specific rather than shared vault state.
- Keep tombstones sticky until retention expires — why: Sticky tombstones prevent deleted documents from being resurrected during sync.
- Keep shared CRDT crates and WASM build in vaultcrdt-plugin — why: The old monorepo is retired and the stale copied crates were removed from vaultcrdt-server.

## Conventions
- Keep Android startup traces off by default — why: The extra traces are for debugging and should not stay noisy by default once the startup issue is understood.
- Keep authentication errors generic — why: Specific auth failures would make vault enumeration easier.
- Use bun run test, not Bun's built-in test runner — why: Bun's built-in test runner can silently skip the Vitest suite.

## Procedures
- Read Android startup perf traces — steps: Check start.startup-state-loaded for cacheEntries and localDirty.
- Deploy server via fleet from vaultcrdt-server — steps: Work from the vaultcrdt-server repo.
- Rebuild and verify WASM only after crates changes — steps: Run cargo fmt --all and cargo clippy --all-targets --workspace -- -D warnings.

## Mistakes
- Android cold-start vault events poisoned dirty tracking — prevention: Ignore vault modify/create/rename events until the first initial sync completes on startup-sensitive Android paths.
- Android mtime caused wrong cache and skip logic — prevention: Do not use Android mtime for caching, skip logic, or sync change detection.

## Plans
- Prepare plugin for community-facing self-hosted release — next: Review the full setup journey from install to first successful sync and remove any gaps that still rely on implicit operator knowledge.
- Audit long-term retention and storage behavior — next: Measure how plugin state, tombstones, VV caches, and server storage grow over time under realistic note churn.
- Review Android startup paths for code quality — next: Audit the startup-related plugin files for temporary branches, duplicated conditions, naming drift, and comments that only made sense during the live bug chase.
