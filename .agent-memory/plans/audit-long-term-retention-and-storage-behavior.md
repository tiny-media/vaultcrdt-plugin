---
id: plan-20260409-7e3d
type: plan
title: Audit long-term retention and storage behavior
project: null
status: active
created_at: 2026-04-09T15:51:20.102326596Z
updated_at: 2026-04-09T15:51:20.102326596Z
salience: 0.8
tags: []
related: []
sources:
- next-session-handoff.md
---

## Goal
Assess whether the plugin and server remain operational and storage-efficient over a theoretical five-year single-user deployment.

## Current state
The sync path works for current usage, but there is no dedicated long-horizon audit yet for CRDT state growth, tombstones, server database growth, or cleanup ergonomics.

## Next steps
- Measure how plugin state, tombstones, VV caches, and server storage grow over time under realistic note churn.
- Decide whether explicit compaction, cleanup, retention review, or maintenance commands are needed for long-lived vaults.
- Document the operational expectations clearly so self-hosters know what to monitor and when intervention is appropriate.
