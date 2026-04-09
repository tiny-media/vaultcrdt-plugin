# Memory Vault Index

## Decisions
- Keep shared CRDT crates and WASM build in vaultcrdt-plugin
  - id: dec-20260408-be54
  - status: active
  - path: .agent-memory/decisions/keep-shared-crdt-crates-and-wasm-build-in-vaultcrdt-plugin.md
- Keep startup dirty tracking device-local
  - id: dec-20260409-c4a7
  - status: active
  - path: .agent-memory/decisions/keep-startup-dirty-tracking-device-local.md
- Keep tombstones sticky until retention expires
  - id: dec-20260408-a618
  - status: active
  - path: ../vaultcrdt-server/.agent-memory/decisions/keep-tombstones-sticky-until-retention-expires.md

## Conventions
- Keep Android startup traces off by default
  - id: con-20260409-1a07
  - status: active
  - path: .agent-memory/conventions/keep-android-startup-traces-off-by-default.md
- Keep authentication errors generic
  - id: con-20260408-47b4
  - status: active
  - path: ../vaultcrdt-server/.agent-memory/conventions/keep-authentication-errors-generic.md
- Use bun run test, not Bun's built-in test runner
  - id: con-20260408-2ab7
  - status: active
  - path: .agent-memory/conventions/use-bun-run-test-never-bun-test.md

## Procedures
- Deploy server via fleet from vaultcrdt-server
  - id: proc-20260408-42f2
  - status: active
  - path: ../vaultcrdt-server/.agent-memory/procedures/deploy-server-via-fleet-from-vaultcrdt-server.md
- Read Android startup perf traces
  - id: proc-20260409-b1a5
  - status: active
  - path: .agent-memory/procedures/read-android-startup-perf-traces.md
- Rebuild and verify WASM only after crates changes
  - id: proc-20260408-43ac
  - status: active
  - path: .agent-memory/procedures/rebuild-and-verify-wasm-only-after-crates-changes.md

## Mistakes
- Android cold-start vault events poisoned dirty tracking
  - id: mis-20260409-2ec5
  - status: active
  - path: .agent-memory/mistakes/android-cold-start-vault-events-poisoned-dirty-tracking.md
- Android mtime caused wrong cache and skip logic
  - id: mis-20260408-0200
  - status: active
  - path: .agent-memory/mistakes/android-mtime-caused-wrong-cache-and-skip-logic.md

## Plans
- Audit long-term retention and storage behavior
  - id: plan-20260409-7e3d
  - status: active
  - path: .agent-memory/plans/audit-long-term-retention-and-storage-behavior.md
- Prepare plugin for community-facing self-hosted release
  - id: plan-20260409-2850
  - status: active
  - path: .agent-memory/plans/prepare-plugin-for-community-facing-self-hosted-release.md
- Review Android startup paths for code quality
  - id: plan-20260409-2add
  - status: active
  - path: .agent-memory/plans/review-android-startup-paths-for-code-quality.md
