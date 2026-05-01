# Externer Task-Handoff | Template

Setup-Version: v0.3-draft

## Zielsystem
`Claude Code | anderes externes Tool`

## Session Name
`<project> | Task | <topic>`

## Goal
What exactly should this external task accomplish?

## Scope
- ...
- ...

## Not in scope
- ...
- ...

## Minimal context package
Only the minimum context required by the external run.

- Task-Auftrag
- selected files or docs
- selected checks
- selected constraints

## Expected return
The external run must return a **Task-Rückmeldung**.

## Failure mode
If the external run cannot proceed cleanly:
- stop scope expansion
- return a blocked or partial Task-Rückmeldung
- include exactly one well-framed open question if needed

## Für Richard
Kurze deutsche Einordnung, warum dieser Task extern läuft und woran du erkennst, dass die Übergabe sauber war.
