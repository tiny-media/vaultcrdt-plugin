---
id: con-20260501-cc33
type: convention
title: Use BRAT for plugin distribution
project: vaultcrdt-plugin
status: active
created_at: 2026-05-01T13:36:09.922923097Z
updated_at: 2026-05-01T13:36:09.922923097Z
salience: 0.6
tags:
- deploy
- brat
related: []
sources:
- Richard 2026-05-01
---

## Convention
Do not deploy VaultCRDT by copying plugin files into local Obsidian vault plugin folders; use BRAT/GitHub releases for plugin installs and updates.

## Scope
vaultcrdt-plugin release and install workflow

## Why
- BRAT is now the intended path on all devices, so old local deploy target paths are stale and should not be treated as canonical memory.
