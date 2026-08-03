# Run inputs reach analysis as a Tinybird Run Snapshot written at Start

**Status:** accepted

The analysis engine reads frozen Experiment Run configuration (including the Control Variant) from
the `analysis_run_inputs` Tinybird pipe, but the system of record for Run config is D1 `runs`, and
no bridge existed between them — only the local e2e stub served the pipe (SPL-186). Three
transports were on the table.

## Decision

The Control Plane writes a **Run Snapshot** — the frozen Run row's analysis fields, with
`control_variant_id` resolved to the Variant name from the frozen `variant_set` — to a
`run_snapshots` Tinybird datasource, synchronously inside the Start handler via the Events API,
using a datasource-scoped `APPEND` token held as a Control Plane Worker secret. The
`analysis_run_inputs` pipe reads it: filter by `app_id`/`environment_id`/`experiment_id`
(+ optional `run_id`), return exactly one row — the requested Run, else latest by `started_at`.

Ordering and failure semantics: Start commits to D1 first (insert the Run before any status flips
reference it), then writes the snapshot. On write failure, a compensating delete removes the
unreferenced Run row and Start fails with a retryable error — Start either fully succeeds or
observably didn't happen. On the double fault (delete also fails), the Run exists without a
snapshot: analysis fails loud with `RUN_NOT_FOUND`, never fabricated inputs.

Shape: plain `MergeTree`, sorting key `app_id, environment_id, experiment_id, started_at`, **no
TTL** (snapshots back historical Results forever), latest-Run resolution at query time (the table
is one row per Run start; ReplacingMergeTree/`FINAL` machinery is for large tables). The row
carries both `control_variant` (name, what analysis consumes) and `control_variant_id` (what
SPL-188's D1-vs-Tinybird disagreement check compares exactly).

Forward-only: Runs started before this ships stay invisible to analysis. No backfill.

## Considered options

- **D1 binding on the Analysis Worker.** Rejected. The Analysis Worker is the single Tinybird
  read-isolation point (SPL-52); a D1 binding gives the analysis surface a second data plane and a
  new place to get app-enforced tenant scoping (ADR-0018) wrong.
- **Carry the snapshot in the ADR-0046 delegated `/results` body.** Rejected. It dies on the
  non-request paths: the hourly snapshot-refresh cron (SPL-66) has no gateway request to carry a
  body, and latest-Run resolution would move back into the gateway, splitting StatsInput
  provenance across two sources.
- **Ship it through the ADR-0043 queue-backed microbatch path.** Rejected. One row per Run start
  does not justify queue infra, and the compensating-delete semantics require a synchronous
  outcome to act on.

## Consequences

- The Control Plane holds its first Tinybird write credential (previously only Event Ingest
  wrote), scoped by token to the one datasource.
- A rare double fault (Tinybird accepted, we saw a timeout, compensating delete succeeded) can
  leave a phantom snapshot with no D1 Run. Accepted: any newer real Run outranks it in latest
  resolution, and SPL-188 is the reconciliation check that flags a Tinybird Run D1 disowns.
