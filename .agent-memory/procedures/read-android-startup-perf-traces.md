---
id: proc-20260409-b1a5
type: procedure
title: Read Android startup perf traces
project: null
status: active
created_at: 2026-04-09T15:28:17.351563535Z
updated_at: 2026-04-09T15:28:17.351563535Z
salience: 0.8
tags: []
related: []
sources:
- next-session-handoff.md
- gpt-audit/archive-2026-04-08-initial-sync-perf/android-tests-performance.md
---

## When to use
When validating Android cold-start performance or investigating initial-sync regressions.

## Steps
1. Check start.startup-state-loaded for cacheEntries and localDirty.
2. Check initial-sync.overlapping.plan for readsPlanned and cleanSkipsPlanned.
3. Check initial-sync.overlapping.done for skippedClean, reads, and elapsedMs.
4. Check initial-sync.complete to confirm total startup duration.
