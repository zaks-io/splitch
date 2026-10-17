import type { ErrorDoc } from "./types";

export const environmentErrorDocs = {
  ENVIRONMENT_EXPIRED: {
    remediation: "Create a replacement Temporary Environment and use its new credentials",
    cause: "The Temporary Environment reached its expiry and is read-only until teardown.",
    fix: "Create a replacement from a source Environment, then replace both SDK credentials. Expiry cannot be extended. Reads remain available until teardown; the old keys are refused immediately at expiry and become revoked after teardown.",
    details:
      '{ environmentId: string, expiredAt: string, recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT" }',
    recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT",
    related: ["CREDENTIAL_REVOKED", "ENVIRONMENT_NOT_FOUND"],
  },
  ENVIRONMENT_KIND_UNSUPPORTED: {
    remediation: "Choose an Environment kind that supports details.attemptedOp",
    cause: "The selected Environment kind does not support the requested operation.",
    fix: "Inspect `details.temporary` and `details.attemptedOp`. Sync requires a Temporary Environment target. Policy edits, Experiment creation, winner Promotion targets, and Convex or Cloudflare installations require a permanent Environment.",
    details: "{ environmentId: string, temporary: boolean, attemptedOp: string }",
    related: ["ENVIRONMENT_EXPIRED", "VALIDATION_ERROR"],
  },
  TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED: {
    remediation: "Delete an unused live Temporary Environment or wait until details.nextExpiresAt",
    cause: "The App has reached its limit of unexpired Temporary Environments.",
    fix: "Delete an unused live Temporary Environment or wait until `details.nextExpiresAt`, then retry creation. Expired Environments awaiting teardown do not count toward the live limit.",
    details:
      '{ appId: string, limit: number, active: number, nextExpiresAt: string, recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT" }',
    recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT",
    related: ["ENVIRONMENT_EXPIRED", "SYNC_LIMIT_EXCEEDED"],
  },
  SYNC_LIMIT_EXCEEDED: {
    remediation: "Use an App within details.limit Flags before retrying create or Sync",
    cause: "The App exceeds the Flag count supported by Temporary Environment create and Sync.",
    fix: "Compare `details.flags` with `details.limit`. The request was refused before any write. The Flag count belongs to the App, so selecting a different source Environment does not remove the limit.",
    details: "{ appId: string, limit: number, flags: number }",
    related: ["TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED", "ENVIRONMENT_SYNC_INCOMPLETE"],
  },
  ENVIRONMENT_SYNC_INCOMPLETE: {
    remediation: "Wait for details.retryAfterMs and retry the original create or Sync operation",
    cause: "Some Flag Configurations could not be copied from the source Environment.",
    fix: "Retry the original operation after `details.retryAfterMs`. An existing target may contain successful partial copies; repeating Sync converges and updates provenance only after complete success. A failed creation is rolled back. `details.failedFlagIds` lists at most 50 failures; `details.failed` is the full count.",
    details:
      "{ environmentId: string, fromEnvironmentId: string, applied: number, failed: number, failedFlagIds: string[], retryAfterMs: number }",
    related: ["SYNC_LIMIT_EXCEEDED", "SERVICE_UNAVAILABLE", "ENVIRONMENT_EXPIRED"],
  },
} satisfies Record<string, ErrorDoc>;
