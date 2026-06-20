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
| [0007](./0007-assignment-store-is-a-sibling-seam-not-behind-the-provider.md) | The Assignment Store is a sibling seam, not behind the Provider |
| [0008](./0008-assignment-store-is-dumb-storage-policy-on-the-evaluate-path.md) | The Assignment Store is dumb storage; replay policy on the evaluate path |
| [0009](./0009-assignment-store-substrate-kv-read-do-write.md) | Assignment Store substrate: KV read, per-key Durable Object write |

0001–0006 come from the Assignment/Exposure seam grills (2026-06-20). They form a chain: 0001 (pure
assignment) enables 0006 (clean holdover predicate); 0002 (immutable Run) is enforced by 0003 (material
edits) and protected by 0006; 0004 (exposure-on-read) forces 0005 (dedup).

0007–0009 come from the Assignment Store seam grills (2026-06-20), which give ADR-0006's durable holdover
state a home and a substrate: 0006 (holdover state exists) needs 0007 (it lives in a sibling Assignment
Store, forced by OpenFeature's read-only Provider contract), 0008 (that store is dumb get/put; replay
policy stays on the evaluate path), and 0009 (its substrate is Workers KV for the hot-path read + a
per-key Durable Object as the serialized first-touch writer, write-through to KV). Design narrative:
[assignment-store-seam.md](../architecture/assignment-store-seam.md).
