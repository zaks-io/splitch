# Storage schemas: KV namespaces and the Assignment Store

KV value schemas (Zod-parsed on every read) plus the Assignment Store's per-Entity KV read model.

Storage shapes carry internals (timestamps, dedup keys, immutability markers) that wire shapes
must not expose. Every Zod-parsed surface is listed here. (ADR-0025 "reuse at the leaf, not the envelope".)

---

## KV namespaces (Zod-parsed on every read)

Every KV value is a JSON blob Zod-parsed on read inside a `schemaVersion` envelope whose version is
**pinned to the current version** (`z.literal`, see `CURRENT_KV_SCHEMA_VERSION`). A malformed blob OR
an unknown/future schema version fails loud — on the evaluation edge (no D1 binding) that is
`INTERNAL_SERVER_ERROR`, never a partial or wrong-version object flowing into evaluation; a
control-plane reader rebuilds from D1 instead (see [../platform/contracts-and-validation.md](../platform/contracts-and-validation.md)).
(ADR-0025 "every KV read is Zod-parsed, including hot-path reads".)

| Namespace key pattern                                   | Value schema         | TTL                          | Notes                                                                                        |
| ------------------------------------------------------- | -------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `app:{appId}:{environmentId}:flag:{flagKey}`            | `FlagConfigKV`       | none (invalidated on change) | Hot-path flag config read; Flag CONFIGURATION is per-Environment (ADR-0027)                  |
| `app:{appId}:{environmentId}:run:{runId}`               | `RunConfigKV`        | none                         | Hot-path live Experiment Run config, read only from `ExperimentConfigKV.liveRunId`           |
| `app:{appId}:{environmentId}:experiment:{experimentId}` | `ExperimentConfigKV` | none (invalidated on change) | Edge Experiment config read; carries nullable `liveRunId` for evaluation and ingest          |
| `live_run:{appId}:{environmentId}:{experimentId}`       | `LiveRunKV`          | none                         | Explicit live Run pointer written on Start and cleared on End; never inferred from latest D1 |
| `cred:{hash}`                                           | `CredentialCacheKV`  | 60s                          | Credential validation cache; evicted on revoke                                               |

### FlagConfigKV

Per-Environment resolved Flag CONFIGURATION (ADR-0027): the App-level Variant catalog narrowed by
`availableVariantNames` plus the Environment's enabled state, default, and targeting.

```
{
  id:                    string
  key:                   string
  environmentId:         string
  experimentId:          string | null   // the Experiment controlling this Flag in this Environment,
                                          // or null when no Experiment controls it. Denormalized here so
                                          // the evaluate path resolves flag -> experiment in the ONE
                                          // getFlag read it already makes — never a second KV lookup
                                          // that could disagree with the flag read (ADR-0034 seam note).
  enabled:               boolean
  defaultVariantId:      string
  variants:              Variant[]
  availableVariantNames: string[]
  targetingRules:        TargetingRule[]
  rollout:               PercentageRollout | null  // baseline rollout for traffic matching NO
                                          // Targeting Rule; null = none. NULLABLE-NOT-ABSENT, like
                                          // experimentId, so the writer must commit to a rollout or
                                          // to null and never leave the baseline ambiguous.
  updatedAt:             string  // ISO 8601; cache-bust signal
}
```

`rollout` is the config-level **baseline**: it decides only traffic that matches no Targeting Rule. A
matched rule wins outright and honours its own `percentageRollout`. Its `salt` is minted server-side
once, on the first write that sets a non-null `rollout`, and is then carried verbatim through every
rewrite of this blob — including every percentage change — so bucket membership stays stable (see
`PercentageRollout` in `leaf-schemas-flag.md`).

`experimentId` is written by the control plane whenever an Experiment begins or stops controlling this
Flag in this Environment (the same write that invalidates this key). It is read atomically with the rest
of `FlagConfigKV`, so the flag and its controlling-Experiment pointer can never be read out of sync. A
null `experimentId` flows straight to the evaluate path's "no live Run" branch — no separate lookup, no
new entity, just a nullable field on config the path already reads.

### RunConfigKV

```
{
  id:                  string
  experimentId:        string
  salt:                string
  allocation:          Record<string, number>  // variantName -> percentage
  variantSet:          Variant[]
  targetingRules:      TargetingRule[]          // resolved snapshot frozen at Start; [] = all eligible
  configHash:          string
  startedAt:           string  // ISO 8601
}
```

`allocation` is keyed by Variant **name** and `targetingRules` is the resolved rule snapshot, mirroring
the Run leaf exactly — the edge evaluates eligibility from the frozen rules and buckets by name without
resolving a Segment or joining ids at read time. `configHash` in KV equals the D1 Run's `configHash`.

Note: `targetingKey` is NOT in `RunConfigKV` — it lives on Experiment. Edge evaluate and ingest read
it from `ExperimentConfigKV` and read `RunConfigKV` only when `ExperimentConfigKV.liveRunId` is
non-null.

### ExperimentConfigKV (added to support edge evaluate)

```
{
  id:               string
  environmentId:    string
  flagId:           string
  targetingKey:     string         // Evaluation Context field name to bucket on (e.g. "userId")
  targetingKeyType: string         // Entity type label stamped as id_type on Exposure (e.g. "user")
  status:           'draft' | 'running' | 'ended' | 'archived'   // lifecycle state; reuses the Experiment leaf's ExperimentStatus
  liveRunId:        string | null
}
```

`status` is carried so the resolved `ExperimentConfig` view (provider-port.md marks it Required) is
hydrated in the one `getExperiment` read — the edge never needs a second resolution to learn whether
the Experiment is live. It reuses the Experiment-leaf `ExperimentStatus` enum, never a redefined set.

`liveRunId` is present-with-null. `null` means no Run is live, so readers must not read
`RunConfigKV`. A non-null value is the only Run id evaluation and ingest readers dereference; missing
or mismatched `RunConfigKV` fails loud. Readers never select the latest D1 Run as a fallback.

### LiveRunKV

```
{
  runId: string
}
```

`live_run:{appId}:{environmentId}:{experimentId}` is an explicit control-plane live signal, written
with the same Start sync that writes `ExperimentConfigKV.liveRunId` and the new `RunConfigKV`, and
deleted with the End sync that reverts `ExperimentConfigKV.liveRunId` to `null`. It exists so
control-plane and proof paths can assert live-Run state without inferring it from D1 history; hot
evaluation and ingest readers still use the `ExperimentConfigKV` → `RunConfigKV` model above.

### CredentialCacheKV

New writes use payload version 2. Active credentials must carry the owning
Organization so data-plane Evaluation usage cannot infer tenant scope from a
request. Revoked tombstones may retain `organizationId: null` because they only
reject the credential. The evaluation reader accepts the schema-v1 payload during
rollout, marks it unscoped, and fails closed for billing-bearing Evaluation.

The control-plane scheduled credential-cache backfill is the compatibility path. It reads every
credential from D1, joins its App to the owning Organization, and rewrites the v2 KV entry using
that D1 value. It never accepts an Organization from the request or guesses from an App name. The
data plane may resume the credential only after the v2 entry is present; a failed or incomplete
backfill therefore remains a visible 503 instead of becoming an unscoped billing write.

```
{
  appId:                   string
  environmentId:           string  // credentials are per-Environment (ADR-0027)
  credentialSchemaVersion: 2
  organizationId:           string | null
  kind:                     'api_key' | 'client_key'
  scopes:                   string[]
  revoked:                  boolean
  cachedAt:                 string  // ISO 8601
}
```

---

## Assignment Store (KV + Durable Object, per ADR-0009)

Not a D1 table. The per-key Durable Object is the serialized writer; KV is the read replica.

KV key pattern: `assignment:{appId}:{idType}:{targetingKeyHash}` — per-Entity, NO `experimentId`.
One read returns all experiments' holdovers for the Entity. `targetingKeyHash` is derived by the
Assignment Store substrate from the raw Targeting Key; the raw value is never placed in KV.

KV value (Zod-parsed on every read):

```
AssignmentStoreValue = Map<experimentId, {
  runId:   string
  variant: string  // Variant name
}>
```

The per-key Durable Object writer is keyed per `(appId, experimentId, idType, targetingKeyHash)` and
merges its record into the Entity-keyed KV map under its `experimentId`. Read granularity
(per-Entity) and write granularity (per-Experiment) differ by design (ADR-0008/0009).

Written at first-touch Exposure (NOT at assignment time). `runId` is stamped from the live Run at
fire-time, so holdovers keep their original Run attribution across Run boundaries.

The Durable Object id is derived from the per-Experiment writer key. Its `putIfAbsent` is atomic (one
winner for concurrent POPs). KV miss on a subsequent read is self-healing — `assign()` is deterministic
and recomputes the same Variant.

## Sources

- [../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md](../../adr/0025-zod-first-contract-hono-openapi-hc-client-derived-everywhere.md)
- [../../adr/0009-assignment-store-substrate-kv-read-do-write.md](../../adr/0009-assignment-store-substrate-kv-read-do-write.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
