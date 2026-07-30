# agents/ — reports from agents and subagents

Any agent (or Claude session) producing research, evaluation, spike results, or review output for LongLeash writes it here.

## Conventions

- One report per file, named `YYYY-MM-DD-topic.md`.
- Start each report with a one-paragraph summary; findings after. Mark unverified claims `[UNVERIFIED]`.
- Raw machine-readable data (JSON etc.) goes in `archive/`, referenced from the report.
- A report that changes project state (a spike passed/failed, a decision made) must also be reflected in `../context/STATE.md` — reports are records, STATE.md is the source of truth.

## Contents

- `2026-07-29-research-summary.md` — condensed findings from the six research domains.
- `2026-07-29-evaluation.md` — three designs, judge scores and grafts, critique verdict and fixes.
- `2026-07-29-phase5-blueprint.md` — archived terminal-adapter specs for the optional Happy fork.
- `archive/` — raw JSON from the planning workflow (research, all three designs, judgment, critique).
