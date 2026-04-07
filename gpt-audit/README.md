# gpt-audit/

External audits of the VaultCRDT codebase, one cycle per dated archive directory.

## Layout

```
gpt-audit/
├── README.md                    ← you are here
├── previous-cycles.md           ← rolling status summary across all past audits
└── archive-<date>/              ← one directory per completed audit cycle
    ├── audit-*.md               ← the raw audit as received
    ├── NN-proposal-*.md         ← expanded per-finding proposals
    ├── 09-decision-matrix.md    ← priority / stage matrix
    ├── claude-response.md       ← Claude's implementation notes + real-life observations
    └── ...                      ← supporting docs (roadmap, risk register, release checklists)
```

## Workflow for a new audit cycle

1. **Seed an empty cycle directory** when a fresh audit arrives:
   `mkdir gpt-audit/archive-<YYYY-MM-DD>/`
2. Drop the raw audit into it (`audit-<YYYY-MM-DD>.md`).
3. Expand findings into per-item proposal files, priority matrix, roadmap as needed.
4. Implement. Document what landed (and what was deliberately deferred) in `claude-response.md` inside the cycle directory.
5. When the cycle is closed, append a 1-paragraph status line to `previous-cycles.md` at the top level and move on.

Cycles never get rewritten after they close — they are historical record. New work lives in a new cycle directory.

## Status

- `archive-2026-04-06/` — first audit cycle, **closed**. 6/8 items implemented, 2 deliberately deferred. See `previous-cycles.md` for the one-paragraph summary.
