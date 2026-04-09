---
id: plan-20260409-2add
type: plan
title: Review Android startup paths for code quality
project: null
status: active
created_at: 2026-04-09T15:51:20.098436179Z
updated_at: 2026-04-09T15:51:20.098436179Z
salience: 0.8
tags: []
related: []
sources:
- next-session-handoff.md
---

## Goal
Re-read the Android startup code after the bug-chase and simplify or harden anything that became overly tactical during the v0.2.31..v0.2.33 repair cycle.

## Current state
The startup behavior is now fast enough, but the code went through many targeted fixes during repeated Android debugging sessions.

## Next steps
- Audit the startup-related plugin files for temporary branches, duplicated conditions, naming drift, and comments that only made sense during the live bug chase.
- Prefer simplification and clearer structure over further micro-optimisation unless a fresh bug reproduces.
- Run the normal validation suite after any cleanup and keep Android-specific tracing off unless actively diagnosing.
