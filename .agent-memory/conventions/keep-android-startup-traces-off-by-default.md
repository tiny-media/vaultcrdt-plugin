---
id: con-20260409-1a07
type: convention
title: Keep Android startup traces off by default
project: null
status: active
created_at: 2026-04-09T15:51:20.091608484Z
updated_at: 2026-04-09T15:51:20.091608484Z
salience: 0.8
tags: []
related: []
sources:
- next-session-handoff.md
---

## Convention
Leave Android startup tracing disabled in normal plugin operation and enable it only for targeted diagnosis.

## Scope
Android startup tracing and temporary performance instrumentation in vaultcrdt-plugin

## Why
- The extra traces are for debugging and should not stay noisy by default once the startup issue is understood.
- Normal users should not pay the mental or runtime cost of always-on diagnostic logging.
