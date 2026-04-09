---
id: con-20260408-2ab7
type: convention
title: Use bun run test, not Bun's built-in test runner
project: vaultcrdt-plugin
status: active
created_at: 2026-04-08T23:57:38.961218445Z
updated_at: 2026-04-08T23:57:38.961218445Z
salience: 0.8
tags:
- testing
- bun
- vitest
related: []
sources:
- CLAUDE.md
- .claude/rules/plugin-src.md
---

## Convention
Run plugin tests with bun run test; do not use Bun's built-in test runner.

## Scope
TypeScript and plugin test runs in vaultcrdt-plugin

## Why
- Bun's built-in test runner can silently skip the Vitest suite.
- Using the explicit script keeps test results aligned with the real project test setup.
