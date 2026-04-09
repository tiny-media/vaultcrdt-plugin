---
id: dec-20260408-be54
type: decision
title: Keep shared CRDT crates and WASM build in vaultcrdt-plugin
project: vaultcrdt-plugin
status: active
created_at: 2026-04-08T23:57:38.956860708Z
updated_at: 2026-04-08T23:57:38.956860708Z
salience: 0.8
tags:
- architecture
- split-repo
- wasm
related: []
sources:
- CLAUDE.md
- .claude/rules/rust-crates.md
- .claude/rules/wasm-build.md
---

## Decision
Keep vaultcrdt-core, vaultcrdt-crdt, vaultcrdt-wasm, and the committed wasm/ build artifacts in vaultcrdt-plugin; vaultcrdt-server stays server-only.

## Why
- The old monorepo is retired and the stale copied crates were removed from vaultcrdt-server.
- One canonical home avoids divergent crate copies and WASM build drift across repos.

## Trade-offs
- Cross-repo work sometimes requires coordinated changes in the sibling server repo.
