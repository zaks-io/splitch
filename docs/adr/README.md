# Architecture Decision Records

Load-bearing decisions, recorded so future architecture reviews don't re-litigate them. Terse by
design — see the format in `~/.claude/skills/grill-with-docs/ADR-FORMAT.md`. Vocabulary follows
[CONTEXT.md](../../CONTEXT.md); fuller design narrative lives in
[docs/architecture/](../architecture/).

| # | Decision |
|---|----------|
| [0001](./0001-assignment-is-pure-not-an-event.md) | Assignment is a pure computation, not an event |
| [0002](./0002-run-is-the-immutable-unit-of-analysis.md) | The Run is the immutable unit of analysis |
| [0003](./0003-material-edits-including-measurement-open-a-new-run.md) | Material edits — including measurement — open a new Run |
| [0004](./0004-exposure-fires-on-read.md) | Exposure fires on read; deferral is an explicit accessor |
| [0005](./0005-exposure-dedup-first-touch-pipeline-authoritative.md) | Exposure dedup is first-touch per (Entity, Run), pipeline-authoritative |
| [0006](./0006-run-boundary-sticky-experience-counted-in-old-run.md) | Run boundary: sticky experience, counted in the old Run |

All six come from the Assignment/Exposure seam grills (2026-06-20). They form a chain: 0001 (pure
assignment) enables 0006 (clean holdover predicate); 0002 (immutable Run) is enforced by 0003 (material
edits) and protected by 0006; 0004 (exposure-on-read) forces 0005 (dedup).
