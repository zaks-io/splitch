# splitch

Unified feature flags and A/B experimentation across the edge. splitch builds on
**Cloudflare Flagship** as the default Provider and the **OpenFeature** standard.
Use Flagship and OpenFeature terms verbatim for flags. Use splitch terms for
experimentation where those standards are silent.

Sources of truth:

- [Flagship concepts](https://developers.cloudflare.com/flagship/concepts/): App, Flag, Variation,
  Targeting Rule, Percentage Rollout, Evaluation Context.
- [OpenFeature glossary](https://openfeature.dev/specification/glossary/): Targeting Key, Variant,
  Fractional Evaluation, Provider, Client, Resolution.

## How to use context

Read this file first for the high-level language, then read the smallest domain context file that
matches the code or spec you are touching. Do not load every domain file by default.

## Domain context map

| Work area                                                                          | Read for                                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`apps/auth-api/CONTEXT.md`](./apps/auth-api/CONTEXT.md)                           | Organization, User, membership, auth ownership                                     |
| [`apps/control-plane-api/CONTEXT.md`](./apps/control-plane-api/CONTEXT.md)         | App, Environment, Flag Configuration, Promotion, Policy, Review, credentials       |
| [`apps/evaluation-api/CONTEXT.md`](./apps/evaluation-api/CONTEXT.md)               | Flag resolution, Targeting, Assignment, Experiment Run, Provider, Assignment Store |
| [`apps/event-ingest-api/CONTEXT.md`](./apps/event-ingest-api/CONTEXT.md)           | Exposure events, raw append-only log, first-touch dedup, activation events         |
| [`apps/analysis-api/CONTEXT.md`](./apps/analysis-api/CONTEXT.md)                   | Metrics, statistics, SRM, CUPED, dimensions, result interpretation                 |
| [`apps/control-panel/CONTEXT.md`](./apps/control-panel/CONTEXT.md)                 | UI terminology for org/app/env navigation, promotion, review flows                 |
| [`apps/cli/CONTEXT.md`](./apps/cli/CONTEXT.md)                                     | CLI wording and key-handling rules                                                 |
| [`apps/mcp-server/CONTEXT.md`](./apps/mcp-server/CONTEXT.md)                       | Agent/MCP wording and key-handling rules                                           |
| [`apps/marketing/CONTEXT.md`](./apps/marketing/CONTEXT.md)                         | Public product copy and terminology boundaries                                     |
| [`packages/contracts/CONTEXT.md`](./packages/contracts/CONTEXT.md)                 | Contract names, schema naming, IDs vs slugs                                        |
| [`packages/sdk/CONTEXT.md`](./packages/sdk/CONTEXT.md)                             | Public SDK language, Client Key, evaluation accessors, Exposure behavior           |
| [`packages/control-plane-sdk/CONTEXT.md`](./packages/control-plane-sdk/CONTEXT.md) | Shared control-plane client language                                               |
| [`packages/ui/CONTEXT.md`](./packages/ui/CONTEXT.md)                               | Shared UI component wording boundaries                                             |

Specs remain the implementation source of truth under [`docs/spec/`](./docs/spec/). ADRs under
[`docs/adr/`](./docs/adr/) record why decisions were made.

## Core terms

**Organization**: the account and ownership unit. It owns Apps and has Users as members. See
[`apps/auth-api/CONTEXT.md`](./apps/auth-api/CONTEXT.md).

**App**: the product or service surface that groups related Flags and hosts Experiments. It belongs
to exactly one Organization and spans one or more Environments. See
[`apps/control-plane-api/CONTEXT.md`](./apps/control-plane-api/CONTEXT.md).

**Environment**: a named deployment context under an App, such as `dev` or `prod`. Each Environment
has its own Flag Configuration, SDK credentials, experiment data, and Environment Policy. See
[`apps/control-plane-api/CONTEXT.md`](./apps/control-plane-api/CONTEXT.md).

**Flag**: a named feature toggle with a key, Variants, Targeting Rules, and enabled state. See
[`apps/evaluation-api/CONTEXT.md`](./apps/evaluation-api/CONTEXT.md).

**Variant**: the OpenFeature term for a possible Flag value. Flagship calls this a Variation, but
Variation is quarantined to the Flagship adapter seam. See
[`apps/evaluation-api/CONTEXT.md`](./apps/evaluation-api/CONTEXT.md).

**Targeting Key**: the stable identifier splitch buckets on and measures against. It may identify a
user, session, workspace, service, or another Entity depending on the desired unit. See
[`apps/evaluation-api/CONTEXT.md`](./apps/evaluation-api/CONTEXT.md).

**Evaluation Context**: the object carrying the Targeting Key and attributes used at evaluation time.

**Provider**: the OpenFeature resolver that retrieves flag values from a source of truth. In splitch,
the default Provider is Cloudflare Flagship. See
[`apps/evaluation-api/CONTEXT.md`](./apps/evaluation-api/CONTEXT.md).

**Experiment**: a test that compares Variants of one or more Flags to measure their effect on
Metrics for a population of Entities. See
[`apps/evaluation-api/CONTEXT.md`](./apps/evaluation-api/CONTEXT.md).

**Entity**: the randomization unit under experiment, identified by the Targeting Key.

**Assignment**: the pure deterministic result of `assign(Experiment Run, Targeting Key)`. It records
nothing on its own.

**Experiment Run**: the immutable, time-boxed unit of experiment analysis. Start, End, and Conclude
are its lifecycle verbs. Do not use "publish" for Runs.

**Conclusion**: the immutable decision evidence recorded when Conclude Ends a Run and selects its
winning Variant. It is a durable D1 domain object, appears as the `conclusion` response member, and
uses the `con_` id prefix. A standalone End creates no Conclusion.

**Run Snapshot**: the frozen Experiment Run configuration (allocation, Control Variant, decision
family, guardrails, dimensions) written to the analytics store at Start as the analysis engine's
Run input. Not the exposure-side "snapshot refresh" rollups and not `snapshot_ts`; those describe
Exposure data, never Run config.

**Exposure**: the event that an Entity actually encountered its assigned Variant. Analysis counts
Exposures, not Assignments. See [`apps/event-ingest-api/CONTEXT.md`](./apps/event-ingest-api/CONTEXT.md).

**Precomputed Evaluations**: the per-Flag resolved results (non-revealing Resolution Details) for
one Evaluation Context across every Flag in an App/Environment, returned by one non-exposing
`evaluate-all` call. What static-context clients hold and SSR bootstraps serialize. Never contains
Targeting Rules, salts, or allocation. See [`packages/sdk/CONTEXT.md`](./packages/sdk/CONTEXT.md).

**Exposure Ticket**: the opaque, server-minted voucher inside Precomputed Evaluations that binds
one fresh live-Run assignment. Redeeming it on first local read is what fires the Exposure; a
client cannot report an Exposure the server did not resolve. See
[`packages/sdk/CONTEXT.md`](./packages/sdk/CONTEXT.md).

**Event Definition**: an App-level schema for one named Metric Event or Web Event. Its immutable
family is selected when created, and its immutable published versions are shared across
Environments.

**Metric Event**: an App/Environment/Entity fact submitted with top-level `track()`. It supplies
Metric values but never becomes the Exposure denominator.

**Web Event**: an App/Environment browser telemetry fact used for exploratory web analytics, never
as a Metric input or the Exposure denominator.

**Web Session**: a bounded browser activity scope that correlates Web Events for exploratory
analytics without creating Entity identity.

**Ambiguous Web Session**: a Web Session containing Web Events from more than one distinct explicit
Entity. Exploratory analysis attributes the session to no Entity.

**Page Context**: the bounded URL-derived envelope on every Web Event: the document pathname and
referrer hostname supplied by the SDK plus the country and device class derived at ingest. Never a
full URL, query string, or fragment.

**Visitor**: the unit behind Web Analytics unique counts, represented only by a daily-rotating
server-derived pseudonym (`visitor_hash`). Exact within one UTC day, approximate across days; not
an Entity and never joined to Experiment analysis.

**Web Analytics**: exploratory analysis of Web Events by Web Session and optional Entity identity,
separate from Experiment measurement.

**Metric**: a fact plus an aggregation. Experiments move or guard Metrics. See
[`apps/analysis-api/CONTEXT.md`](./apps/analysis-api/CONTEXT.md).

**Promotion**: applying a Flag Configuration, or a Variant's availability, to a target Environment.
The target may be the Run's own Environment or another Environment. Promote is the deployment verb.
Start is the measurement verb.

**Client Key**: the public, non-secret key used by untrusted client-side SDKs. Safe to embed in
client code. See [`packages/sdk/CONTEXT.md`](./packages/sdk/CONTEXT.md).

**API Key**: the secret server-side SDK key. Never ship it to a browser or read back an existing
value after creation.

## Relationships

- Organization owns Apps and has Users as members.
- App owns Flags, hosts Experiments, and spans Environments.
- Flag definition is App-level. Flag Configuration is per-Environment.
- Each Environment has its own Client Key, API Key, experiment data, and Environment Policy.
- Targeting selects Variants using Evaluation Context keyed by the Targeting Key.
- Experiment controls Flags while running. It does not own them.
- Experiment randomizes Entities across Variants. One Variant is the Control; the rest are Treatments.
- Assignment is pure. Exposure is the assignment seam's recorded event and analysis denominator.
- Experiment Runs freeze assignment config. Assignment edits open a new Run; measurement edits
  recompute over the existing Run.
- Event Definitions are App-level and have one immutable `metric` or `web` family. Each accepted
  Metric Event or Web Event is stamped with one immutable published Event Definition Version.
- Event payload strings are immutable definition-time machine-token allowlists; free-form strings and
  direct-PII property names are not valid Event Definitions.
- Metric Events carry explicit Entity identity. The raw Targeting Key is never stored, and the
  App-scoped pseudonym remains stable under routine key rewrapping.
- Metrics reference only `metric` Event Definitions; Web Events remain outside experiment
  measurement.
- Every Web Event belongs to one Web Session and may also carry explicit Entity identity.
- Exploratory analysis associates a Web Session with an Entity only when exactly one distinct Entity
  appears in the session. A session containing multiple Entities is an Ambiguous Web Session and is
  attributed to none.
- Web Session stitching never creates an Entity, Assignment, Exposure, or Metric Event.
- Web Analytics reads Web Events and never changes Experiment results.
- Metric and Web Event reads collapse physical retries to one logical row per `dedup_key` before any
  count, journey, percentile, or statistical aggregation.
- Metrics are computed over first-touch unique Entities per Run. SRM uses the same denominator.

## Reserved language

- Use **App**, not Site, Project, Tenant, Workspace, or Account.
- Use **Organization**, not Tenant, Workspace, or Account.
- Use **Variant**, not Variation, arm, bucket, group, or treatment for the Flag value itself.
- Use **Targeting Key**, not userId, unitId, subjectId, or sessionId as the domain term.
- Use **Experiment Run**, not phase, version, configVersion, or analysis window.
- Use **Promote** for applying Flag Configuration to a target Environment.
- Use **Start**, **End**, and **Conclude** for Experiment Run lifecycle.
- Do not use **publish** for either Promotion or Experiment Run lifecycle.
- Use **publish** only for immutable Event Definition Versions.
- Use **Client Key** for public client-side credentials and **API Key** for secret server-side
  credentials.
- Slugs exist only for human and agent-readable URLs. IDs are canonical in code, data, and APIs.

## Notes

- This (`~/src/splitch`) is the canonical repo.
- Context files are glossary and lookup files only. Implementation details, storage seams, package
  layout, and deployment workflow live in specs and repo config.
