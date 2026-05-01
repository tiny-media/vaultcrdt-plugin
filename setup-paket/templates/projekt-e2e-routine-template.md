# Projekt-E2E-Routine | Template

Stand: 2026-04-22

## Goal
What exactly should this project's E2E routine protect?

- ...
- ...

## Scope
Which surfaces matter here?

- public site
- CMS / admin
- auth / session
- forms / publish / checkout / upload
- ...

## Preflight
Cheap checks before browser E2E.

- `...` — lint
- `...` — typecheck
- `...` — build
- `...` — unit / integration

## Smoke
Small deterministic green-path journeys.

### Default smoke runner
- `...`

### Journeys
1. `...`
2. `...`
3. `...`

### Success signals
- URL / redirect: `...`
- UI state / H1 / notice: `...`
- meaningful effect: `...`

## Regression
Committed repeatable browser paths.

### Default regression runner
- `...`

### Current regression journeys
1. `...`
2. `...`

### Promotion rule
A smoke becomes regression here only if:
- ...
- ...
- ...

## Attach / Debug
Live browser attach / session reuse path.

### Default attach path
- `google-chrome --remote-debugging-port=9222 --user-data-dir="..."`
- or: `...`

### Use this mode for
- SSO / 2FA
- real cookies / session restore
- reproduced bugs
- ...

## Runner defaults
Tool choice by mode.

- repo-native validated path first: `...`
- project-overarching fallback: `Playwright CLI | ...`
- lightweight alternative: `Bun.WebView / bunwv | ...`
- not default: `MCP | ...`

## Session / Worker defaults
Recommended task level for external runs.

- tiny green-path smoke: `...`
- normal local E2E task: `...`
- drift / flaky path / deep browser triage: `...`

## Startup
What must be running before E2E starts?

- backend: `...`
- CMS / app: `...`
- site: `...`
- upload / queue / workers: `...`

## Credentials / Bootstrap
How does a test session get access without guessing?

- login URL: `...`
- test user source: `...`
- seed / bootstrap command: `...`
- instance / tenant hints: `...`

## Artifacts
Where do failure artifacts go?

- screenshots: `...`
- summaries: `...`
- traces: `...`
- logs: `...`

## Return format
What should come back to Projektleiterin / AG?

- `PASS | FAIL`
- smallest blocker
- artifact path
- runner drift vs product bug hint if relevant

## Risks
Known E2E risks in this project.

- ...
- ...

## For Richard
Kurze deutsche Erklärung:
- was hier der kleine brauchbare Default ist
- was bewusst noch nicht als Regression gilt
- wann du auf schwereren Debug-Modus hochschalten solltest
