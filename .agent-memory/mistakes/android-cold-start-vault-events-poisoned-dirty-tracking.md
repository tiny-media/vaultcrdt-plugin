---
id: mis-20260409-2ec5
type: mistake
title: Android cold-start vault events poisoned dirty tracking
project: null
status: active
created_at: 2026-04-09T15:28:17.344907301Z
updated_at: 2026-04-09T15:28:17.344907301Z
salience: 0.8
tags: []
related: []
sources:
- next-session-handoff.md
- gpt-audit/archive-2026-04-08-initial-sync-perf/trace-findings.md
---

## What happened
Android fired a burst of vault modify/create/rename events during cold start, which immediately refilled the local dirty tracker and disabled the no-read startup fast path.

## Root cause
Cold-start vault events on Android are noisy host events and are not reliable evidence of user edits during the startup window.

## Prevention
- Ignore vault modify/create/rename events until the first initial sync completes on startup-sensitive Android paths.
- Use editor-change events, not raw vault events, as the trusted signal for startup dirty tracking.
