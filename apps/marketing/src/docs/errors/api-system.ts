import type { ErrorDoc } from "./types";

export const systemErrorDocs = {
  MULTIPLE_VARIANT_CONFLICT: {
    cause:
      "One Entity was observed under more than one Variant in the same Run, so it is bucketed to `__multiple__` and its contribution is untrusted.",
    fix: "This is a data-integrity signal, not a transient failure. It usually means the Targeting Key changed identity mid-Run, or two clients evaluated the same subject under different keys. Results that include the affected Entity are not safe to decide on: correct the Targeting Key and start a new Run.",
    details: "{ experimentId: string, runId: string, idType: string, targetingKeyHash: string }",
    related: ["TARGETING_KEY_MISMATCH", "RUN_FROZEN"],
  },
  ATTENTION_FANOUT_LIMIT_EXCEEDED: {
    cause:
      "The App-wide attention rollup spans more Environments and running Experiments than it will read in one pass. It issues one Analysis read per running Experiment per Environment, and past the budget it refuses the whole read.",
    fix: "Read attention per Environment instead: list Experiments per Environment, then read each running one's results. Retrying the rollup never clears this. The refusal is whole rather than partial because a truncated rollup renders as `clear` for the Environments it dropped, which reads as good news that was never checked.",
    details:
      '{ appId: string, limit: number, environments: number, runningExperiments: number | null, recommendedAction: "READ_PER_ENVIRONMENT" }',
    recommendedAction: "READ_PER_ENVIRONMENT",
    related: ["SERVICE_UNAVAILABLE"],
  },
  RATE_LIMITED: {
    cause: "The caller exceeded the rate budget for this surface.",
    fix: "Back off for `details.retryAfterMs` and retry. The same value is on the `Retry-After` response header.",
    details: "{ retryAfterMs: number }",
    related: ["SERVICE_UNAVAILABLE"],
  },
  SERVICE_UNAVAILABLE: {
    cause:
      "The edge returned HTTP 503: Provider configuration could not be resolved. This is retryable and does not mean your Flag is misconfigured.",
    fix: 'Retry after `details.retryAfterMs`. In the SDK this surfaces as `errorCode: "SERVICE_UNAVAILABLE"` with `reason: "ERROR"` and your `defaultValue` — never as a pretended Variant. Client-side transport failures (local throw, timeout, unparseable body) use distinct `SDK_TRANSPORT_*` codes instead of this one.',
    details: "{ retryAfterMs: number }",
    related: [
      "RATE_LIMITED",
      "INTERNAL_SERVER_ERROR",
      "SDK_TRANSPORT_NETWORK",
      "SDK_TRANSPORT_TIMEOUT",
      "SDK_TRANSPORT_PARSE",
    ],
  },
  PRIVACY_JOB_FAILED: {
    cause:
      "A privacy job did not complete against every store, so subject data may remain in the ones it could not reach.",
    fix: "`details.failedStores` names which stores were not completed. Re-run the job for `details.requestId`. The job reports failure rather than partial success precisely because a partially-completed erasure that reports success is a compliance problem.",
    details: "{ requestId: string, failedStores: string[] }",
    related: ["PRIVACY_JOB_NOT_FOUND", "PRIVACY_CONFIRMATION_REQUIRED"],
  },
  INTERNAL_SERVER_ERROR: {
    cause: "An unhandled fault on the platform side. Nothing about the request was at fault.",
    fix: "Retry once. If it persists, report the code with the request context. `details.fault` names the broken seam when the platform could identify it; a corrupted stored configuration surfaces here rather than being served as a plausible default.",
    details: "{ fault?: string }",
    related: ["SERVICE_UNAVAILABLE", "APPROVAL_APPLICATION_FAILED"],
  },
} satisfies Record<string, ErrorDoc>;
