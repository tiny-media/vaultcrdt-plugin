---
id: dec-20260409-c4a7
type: decision
title: Keep startup dirty tracking device-local
project: null
status: active
created_at: 2026-04-09T15:28:17.338127572Z
updated_at: 2026-04-09T15:28:17.338127572Z
salience: 0.8
tags: []
related: []
sources:
- next-session-handoff.md
- gpt-audit/archive-2026-04-08-initial-sync-perf/trace-findings.md
---

## Decision
Store startup dirty tracking in device-local storage keyed by vaultId and peerId, not in a synced vault file.

## Why
- Dirty state is device-specific rather than shared vault state.
- Putting the flag into vv-cache.json makes one device's startup heuristics leak into other devices.

## Trade-offs
- Dirty tracking is no longer inspectable from synced vault artifacts alone.
- Each device must rebuild its own local dirty state after reinstall or storage loss.
