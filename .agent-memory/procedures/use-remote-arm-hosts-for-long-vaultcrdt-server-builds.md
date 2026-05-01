---
id: proc-20260501-c626
type: procedure
title: Use remote ARM hosts for long VaultCRDT server builds
project: vaultcrdt
status: active
created_at: 2026-05-01T13:15:42.337160850Z
updated_at: 2026-05-01T13:15:42.337160850Z
salience: 0.85
tags:
- build
- server
- remote-hosts
related: []
sources:
- '2026-05-01 remote host probe: home=aarch64 Linux Docker, macStudio=arm64 Darwin Rust only'
---

## When to use
When Rust server checks, Docker image builds, or other long-running VaultCRDT build jobs would run on the laptop or need to match the ARM Linux production server.

## Steps
1. Prefer ssh home for deployable vaultcrdt-server Docker builds because home is the target aarch64 Fedora/Asahi Linux host and has Docker.
2. Use rsync to a temporary worktree such as /tmp/vaultcrdt-server-remote-check and exclude target, data, .git, .agent-memory, .claude, and secrets.
3. Use macStudio only for cargo-only sanity checks unless Docker or a Linux ARM container builder is installed there; binaries built directly on macStudio are macOS arm64 and cannot be copied to home as Linux server binaries.
4. Do not deploy, restart, tag, or push from remote build runs without explicit Richard approval.
5. Keep .dockerignore small so remote Docker builds do not transfer target/data or multi-GB contexts.
