# Security Policy

## Supported versions

The `main` branch and the latest tagged release receive security fixes.
Pre-release builds (BRAT betas) are provided as-is; report against the
latest tag or main.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability). Reports sent there reach the maintainer
directly and are not visible publicly.

If you cannot use private reporting, email the address listed on the
maintainer's GitHub profile with the subject `vaultcrdt security`.

Please do **not** open a public issue for anything security-sensitive.

## Scope

- The Obsidian plugin in this repository (`src/`, `wasm/`, bundled `main.js`).
- The matching server implementation maintained alongside it
  (`vaultcrdt-server`): its HTTP/WebSocket API, authentication, storage and
  blob handling — when deployed as documented in its README.

Out of scope: vulnerabilities in Obsidian itself, in other community plugins,
or in infrastructure you do not operate.

## What to include

A clear description of the defect, the affected code path or message flow,
and the impact you see. Proof-of-concept details are welcome in a private
report but are not required — a precise description is enough to start.

## Good-faith expectations

Please interact only with instances you operate or are authorized to test,
keep data access to the minimum needed to demonstrate the issue, and avoid
degrading service for other users. A product defect observed on someone
else's deployment is still worth reporting — describe it without further
testing there.

## Response expectations

- Confirmation of receipt within 7 days.
- A status update at least every 14 days until resolved.
- An assessment and a fix path for accepted reports, coordinated with you
  before any public disclosure.
- If we cannot fix an issue, we will say so and document a mitigation
  or a known-limitation advisory instead of staying silent.
- Credit in the release notes if you wish.

## Disclosure

We follow coordinated disclosure: please allow time for a fix and a release
before publishing details — 90 days from report is our default window,
shorter if we agree together. Once fixed, reports are published as a GitHub
security advisory with your involvement.
