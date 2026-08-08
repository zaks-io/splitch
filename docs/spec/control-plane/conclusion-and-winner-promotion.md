# Experiment conclusion and winner Promotion

Final-state contract for turning one server-owned Experiment Run result into an immutable decision
and, separately, Promoting the selected Variant into a target Environment. Result computation and
hosted Promotion are outside this contract.

## Four different operations

| Operation                            | Effect on Run                  | Effect on target Flag Configuration                          | Durable decision evidence                                         |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Read Results                         | None                           | None                                                         | None                                                              |
| Standalone End                       | `running -> ended`             | None                                                         | None                                                              |
| Conclude                             | `running -> ended`             | None                                                         | Creates one immutable conclusion and one pending Approval Request |
| `approve_and_apply` winner Promotion | None; the Run is already ended | Applies the Approval Request's exact Flag Configuration diff | Appends the canonical Review result                               |

Reading Results and the decision-diagnostic reads are read-only. Standalone End remains the path for
an inconclusive or abandoned Run. It selects no Variant and cannot later be treated as a conclusion.
Run End is never rolled back to hide a declined, stale, or failed Promotion.

## Conclude endpoint

### `POST /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/runs/{run_id}/conclusions`

The path selects the Run. The strict body is:

```ts
type ConcludeRunRequest = {
  selectedVariant: string;
  expectedResultToken: `sha256:${string}`;
  dataWatermark: string;
  target: {
    environmentId: string;
    flagId: string;
    expectedConfigVersion: number;
    proposedConfig: {
      enabled: boolean;
      availableVariantNames: string[];
      targetingRules: TargetingRule[];
      rollout: { percentage: number } | null;
    };
  };
  review?: { action: "approve_and_apply" };
  reason?: string;
  idempotencyKey: string;
};
```

`flagId` must be the Flag controlled by the Experiment. The target Environment belongs to the same
App and may be the Run's own Environment. `selectedVariant` must belong to the Run's frozen Variant
set and be available in the complete proposed target Configuration. The caller sends the complete
proposed write projection. The server never guesses a rollout, silently adds a Variant, or derives a
Configuration from the selected Variant's name. Empty or invalid diffs fail with `VALIDATION_ERROR`
before End.

All ordinary Promotion validation that does not depend on the Run becoming ended runs before End,
including dangling Variant references, baseline ambiguity, and Flag Configuration validation.
Existing errors such as `RUN_FROZEN` and `VARIANT_NOT_AVAILABLE` are reused. For Promotion into the
Run's own Environment, the Run being concluded is not a target freeze after the conclusion commit;
canonical application checks the post-End state. Any other target freeze still blocks application.
If another target Run freezes the Configuration before application, canonical application returns
`APPROVAL_APPLICATION_FAILED` with the nested `RUN_FROZEN` error and leaves the request `pending`; it
never delays the write until that target Run ends. Only target Configuration version drift makes the
Approval Request `stale`.

The server computes the ordinary `ApprovalDiff`; callers cannot submit diff entries. For operation
`experiment_winner_promote`, both `diff.current` and `diff.proposed` use this projection:

```ts
type WinnerPromotionProjection = {
  decision: {
    conclusionId: string;
    runId: string;
    selectedVariant: string;
    resultToken: `sha256:${string}`;
  };
  flagConfiguration: FlagConfigResponse;
};
```

The `decision` member is identical on both sides, so generated entries describe only the exact Flag
Configuration changes. This carries the selected Variant and evidence link inside the existing open
`ApprovalDiff` snapshots without changing the Approval Request contract. The Approval target remains
`type: "flag_configuration"`; target versioning, Review authorization, idempotency, staleness, and
application failure follow [the canonical Approval Request contract](../contracts/error-responses.md#approval-request-and-review-errors).

Before computing the diff, the server applies the existing Promotion rule for the server-owned
baseline salt: preserve the target salt or mint it once when establishing a baseline. The resulting
complete proposed Flag Configuration, including that salt, is what the Approval Request and
conclusion evidence freeze. A replacement request reuses it rather than minting a different target.

A successful response is:

```ts
type ConcludeRunResponse = {
  run: RunResponse; // ended
  conclusion: {
    id: string;
    runId: string;
    selectedVariant: string;
    resultToken: `sha256:${string}`;
    dataWatermark: string;
    concludedAt: string;
  };
  approvalRequest: ApprovalRequest;
};
```

Without inline Review, `approvalRequest.status` is `pending`. With successful inline Review it is
`applied`. An inline application failure returns the canonical `APPROVAL_APPLICATION_FAILED` error;
its Approval Request diff carries `conclusionId`, so the already-committed evidence remains directly
addressable.

Winner Promotion has a `confirm` minimum Review level. The effective Review level is the stricter of
that floor and the target Environment Policy levels for every changed field. This decision-specific
classification guarantees the required Approval Request even when the ordinary field change would be
`allow`; it does not add an Approval Request status or Review action. Under `confirm`, an inline
`review` lets the proposer self-Review. Future `approve` requires a distinct authorized principal.

## Result identity and decision gate

The conclusion-capable Results read adds the all-or-nothing `data_watermark` and `result_token` pair
to a ready `AnalysisResultsEnvelope`. A ready envelope without the pair remains a valid ordinary
Results response, but it cannot be concluded; Conclude returns `DECISION_RESULT_UNAVAILABLE` with
`envelopeState: "ready"`. `result_token` is SHA-256 over UTF-8 RFC 8785 JSON Canonicalization Scheme
bytes of
`{ appId, environmentId, experimentId, runId, runConfigHash, stats }`. The watermark is excluded from
the token, so advancing an ingest boundary without changing the computed result does not create
false staleness.

Conclude recomputes the selected Run through the inclusive `ingest_ts <= dataWatermark` boundary the
caller observed. `dataWatermark` comes from `deduped_exposures.watermark_ts`, the inclusive Copy Pipe
watermark, so a row exactly equal to it was part of the observed Results and must remain part of the
recomputation. Conclude compares that recomputation with `expectedResultToken`; a mismatch returns
`DECISION_RESULT_STALE`. The server does not advance or quantize the submitted watermark. New
Exposures after that boundary do not create a retry race. The client cannot submit Stats output, and
the server treats the submitted watermark only as the evidence boundary. The token match proves the
Stats output at that boundary. The immutable evidence records the recomputed server result and that
exact watermark.

If the selected ready envelope lacks the evidence pair, or recomputation produces an
`AnalysisResultsEnvelope` with `state: "no_data"` or `state: "no_run"`, Conclude returns
`DECISION_RESULT_UNAVAILABLE`. The error's `envelopeState` names `ready`, `no_data`, or `no_run`.
There is no current result token to compare in any of these cases, so they never return
`DECISION_RESULT_STALE`.

The server evaluates every applicable check and returns all failures in one `DECISION_BLOCKED`
response. It never stops at the first failure.

| Failure code                        | Failed `decisionGateCheckIds` member     | Exact blocking condition                                                                         |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DECISION_CONTROL_IDENTITY_INVALID` | `control_identity`                       | The Run's frozen Control Variant cannot be resolved inside its own frozen Variant set            |
| `DECISION_RESULT_INVALID`           | `engine_status`, `decision_valid_result` | A decision-valid result has `status: "error"`, or the locked decision family has no result       |
| `DECISION_UNDERPOWERED`             | `underpowered`                           | Any decision-valid result is still collecting or insufficient, or `health.low_n_warning` is true |
| `DECISION_SRM_MISMATCH`             | `exposure_srm`, `activated_srm`          | Full-exposed SRM fires, or activated-population SRM fires when an Activation Metric exists       |
| `DECISION_ACTIVATION_IMBALANCE`     | `activation_balance`                     | An Activation Metric exists and the per-Variant activation-rate check fires                      |

This table is a transport projection of the shipped Experiment decision gate. Conclude blocks exactly
when its `shipAllowed` is false and derives failures only from checks whose `status` is `fail`.
Guardrail advisories and the `__multiple__` quarantine warning remain visible diagnostics; they are
not members of `decisionGateCheckIds` and do not block conclusion. The Stats engine's boolean verdict
is authoritative for SRM and Activation imbalance. A rendering surface never reapplies thresholds.
A caution-band SRM whose mismatch boolean is false remains diagnostic and does not block.

The strict request schema has no override, bypass, force, or "ship anyway" field. `DECISION_BLOCKED`
cannot be Reviewed into success. The underlying result must change, or a different valid Run must be
Started and concluded.

Authentication and App `owner` or `admin` authorization run before Run, result, or target disclosure.
They return the existing `UNAUTHORIZED` or `FORBIDDEN` errors and write nothing. A target
Configuration version mismatch returns `TARGET_CONFIGURATION_STALE` and writes nothing. Once an
Approval Request exists, later target drift uses the existing `APPROVAL_REQUEST_STALE` error.

## Durable ordering and failure recovery

Conclude is ordered as follows:

1. Strictly parse, authenticate, authorize, and replay an exact idempotent result if one exists.
2. Re-read the selected Run and target Flag Configuration inside the App and Environment scopes.
3. Compare `expectedConfigVersion`; a mismatch stops before analytics or writes.
4. Recompute Results at the caller's `dataWatermark`, return unavailable or stale evidence before any write, and evaluate the shipped decision gate.
5. In one D1 transaction, recheck Run and target versions, End the Run, insert immutable conclusion evidence, and create the target-versioned pending Approval Request.
6. After commit, clear the live Run KV projection. A projection failure is loud and retryable; D1 remains canonical.
7. If inline Review was requested, invoke canonical `approve_and_apply` in a second D1 transaction.

Step 5 is the conclusion commit. Step 7 is the Promotion commit. They are deliberately not one
transaction. Under `confirm` they remain one user interaction, but a crash or application failure
between them leaves a recoverable pending request and an ended Run.

| Outcome after conclusion commit | Run   | Evidence | Target Flag Configuration     | Approval Request                       |
| ------------------------------- | ----- | -------- | ----------------------------- | -------------------------------------- |
| Review applied                  | ended | retained | exact diff applied atomically | `applied`                              |
| Review declined                 | ended | retained | unchanged                     | `declined`                             |
| Target drift                    | ended | retained | unchanged                     | `stale`                                |
| Application failed              | ended | retained | unchanged                     | `pending`; retry with a new Review key |

Conclude creation binds `idempotencyKey` to the canonical request hash. An exact retry returns the
same conclusion, Approval Request, and inline Review outcome. Reusing it with different intent returns
`IDEMPOTENCY_KEY_CONFLICT`. Review retries follow the existing Review idempotency contract.
Failures before the conclusion commit bind no key and write no idempotency row.

A stale request cannot be revived. An authorized operator creates a replacement from the frozen
conclusion with:

`POST /apps/{app_id}/envs/{environment_id}/experiments/{experiment_id}/runs/{run_id}/conclusions/{conclusion_id}/promotion-requests`

The strict body is `{ expectedConfigVersion, review?, idempotencyKey }`. The server reuses the
immutable selected Variant and proposed target Configuration, recomputes the diff against the named
current version, and creates a newly versioned Approval Request. It never changes the conclusion.
This route is available only when the previous request is `stale`; failed application uses Review
retry semantics instead.

## Permanent evidence

The D1 shape and immutability rules live in
[storage-schemas-d1-experiment.md](../contracts/storage-schemas-d1-experiment.md#experiment_conclusions).
The complete server-owned Stats output, every decision check and its inputs, selected Variant, exact
proposed target Configuration, result token, data watermark, actor, reason, and Approval Request links
are retained without truncation. Only parent App deletion may remove this history under the existing
privacy lifecycle. Tinybird audit projection is additive evidence, never the mutation authority.

## Sources

- [run-state-machine.md](run-state-machine.md)
- [endpoints-flag-segment.md](endpoints-flag-segment.md#one-approval-request-and-review-mechanism)
- [../stats/decision-diagnostics.md](../stats/decision-diagnostics.md)
- [../stats/srm-and-health.md](../stats/srm-and-health.md)
- [../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md](../../adr/0012-activation-gate-semantics-ordering-reanchor-and-bias-guardrails.md)
- [../../adr/0030-statistical-rigor-is-an-enforced-product-contract.md](../../adr/0030-statistical-rigor-is-an-enforced-product-contract.md)
