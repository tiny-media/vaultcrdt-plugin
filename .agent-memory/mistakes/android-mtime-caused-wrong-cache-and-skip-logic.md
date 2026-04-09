---
id: mis-20260408-0200
type: mistake
title: Android mtime caused wrong cache and skip logic
project: vaultcrdt-plugin
status: active
created_at: 2026-04-08T23:57:38.967568788Z
updated_at: 2026-04-08T23:57:38.967568788Z
salience: 0.8
tags:
- android
- caching
- sync
related: []
sources:
- CLAUDE.md
- .claude/rules/plugin-src.md
---

## What happened
mtime-based logic on Android led to unreliable cache or skip decisions in the plugin.

## Root cause
Android file mtimes are not stable enough for trustworthy change detection in this project.

## Prevention
- Do not use Android mtime for caching, skip logic, or sync change detection.
- Use explicit revision tokens, hashes, or server state instead.
