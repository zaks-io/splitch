import type { ErrorDoc } from "./types";

export const decisionErrorDocs = {
  DECISION_BLOCKED: {
    cause:
      "One or more checks in the shipped Experiment decision gate failed, so the Run cannot be concluded.",
    fix: "Read every member of `details.failures`; each one names the failed gate check and its evidence. Resolve the underlying result condition or Start a different valid Run. There is no override path.",
    details:
      "{ runId: string, resultToken: string, dataWatermark: string, failures: DecisionFailure[] }",
    related: ["DECISION_RESULT_UNAVAILABLE", "DECISION_RESULT_STALE"],
  },
  DECISION_RESULT_STALE: {
    cause:
      "The selected Run's server-owned result at the submitted data watermark does not match the result token the caller observed.",
    fix: "Read the conclusion-capable Results response again and resubmit its complete `data_watermark` and `result_token` evidence pair. Do not reuse the stale token.",
    details: "{ runId: string, expectedResultToken: string, currentResultToken: string }",
    related: ["DECISION_RESULT_UNAVAILABLE", "DECISION_BLOCKED"],
  },
  DECISION_RESULT_UNAVAILABLE: {
    cause:
      "The selected Run has no decision-bearing result evidence: the envelope is not ready, or its ready response lacks the conclusion evidence pair.",
    fix: "Read `details.envelopeState`. For `ready`, use a conclusion-capable Results read that returns both evidence fields. For `no_data`, wait for the required analysis inputs. For `no_run`, Start a Run before concluding.",
    details: '{ runId: string, envelopeState: "ready" | "no_data" | "no_run" }',
    related: ["DECISION_RESULT_STALE", "DECISION_BLOCKED"],
  },
  TARGET_CONFIGURATION_STALE: {
    cause:
      "The target Flag Configuration changed after the caller read the version used for the conclusion proposal.",
    fix: "Read the current target Flag Configuration and create a new proposal against its current version. No Run or target state changed.",
    details:
      '{ flagId: string, environmentId: string, expectedConfigVersion: number, currentConfigVersion: number, recommendedAction: "REFRESH_AND_REPROPOSE" }',
    recommendedAction: "REFRESH_AND_REPROPOSE",
    related: ["APPROVAL_REQUEST_STALE", "DECISION_RESULT_STALE"],
  },
} satisfies Record<string, ErrorDoc>;
