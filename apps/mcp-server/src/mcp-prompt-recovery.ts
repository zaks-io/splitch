import { type RecommendedAction, recommendedActions } from "@splitch/contracts";
import {
  type McpPromptMessage,
  type McpPromptPlan,
  message,
  operationIdFromMessage,
  PromptArgumentError,
  promptDescription,
  RECOVERY_OPERATION_IDS,
  toolMessage,
} from "./mcp-prompt-types";

/**
 * The `recover_from_error` plan. Split out of mcp-prompt-plans.ts for file size;
 * it is the one plan driven by a server error rather than a user intent, so it
 * carries its own `recommendedAction` -> tool-sequence mapping.
 */

const RECOMMENDED_ACTION_SET = new Set<string>(recommendedActions);

export function recoverFromErrorPlan(
  errorCode: string,
  detailsRaw: unknown,
  flagId?: string,
): McpPromptPlan {
  const details = parseDetails(detailsRaw);
  const recommendedAction = details.recommendedAction;
  if (typeof recommendedAction !== "string" || !RECOMMENDED_ACTION_SET.has(recommendedAction)) {
    throw new PromptArgumentError(
      `recover_from_error requires details.recommendedAction to be one of ${recommendedActions.join(", ")}.`,
    );
  }
  const action = recommendedAction as RecommendedAction;
  if (action === "CREATE_NEW_RUN" && !flagId) {
    throw new PromptArgumentError(
      'recover_from_error requires prompt argument "flagId" when recommendedAction is CREATE_NEW_RUN.',
    );
  }
  const operationIds = RECOVERY_OPERATION_IDS[action];
  return {
    description: promptDescription("recover_from_error"),
    operationIds,
    messages: recoveryMessages(errorCode, action, details, operationIds, flagId),
  };
}

function recoveryMessages(
  errorCode: string,
  action: RecommendedAction,
  details: Record<string, unknown>,
  operationIds: readonly string[],
  flagId?: string,
): readonly McpPromptMessage[] {
  const messages: McpPromptMessage[] = [
    message(
      "user",
      `Recover from errorCode=${errorCode} with recommendedAction=${action}. Execute only the tools named below, in order. This plan never mutates by itself.`,
    ),
    ...recoverySteps(action, details, flagId),
  ];

  const named = messages
    .map((entry) => operationIdFromMessage(entry))
    .filter((id): id is string => id !== null);
  if (named.length !== operationIds.length || named.some((id, i) => id !== operationIds[i])) {
    throw new Error(
      `mcp-prompts: recovery message tool order drifted for ${action}: expected ${operationIds.join(", ")}, got ${named.join(", ")}`,
    );
  }
  return messages;
}

const APPROVAL_RECOVERY_ACTIONS = new Set<RecommendedAction>([
  "REVIEW_APPROVAL_REQUEST",
  "REFRESH_AND_REPROPOSE",
  "RETRY_REVIEW",
]);

function isApprovalRecoveryAction(
  action: RecommendedAction,
): action is "REVIEW_APPROVAL_REQUEST" | "REFRESH_AND_REPROPOSE" | "RETRY_REVIEW" {
  return APPROVAL_RECOVERY_ACTIONS.has(action);
}

function recoverySteps(
  action: RecommendedAction,
  details: Record<string, unknown>,
  flagId?: string,
): readonly McpPromptMessage[] {
  if (isApprovalRecoveryAction(action)) {
    return approvalRecoverySteps(action, details);
  }
  if (action === "CHOOSE_DIFFERENT_SLUG") {
    return chooseDifferentSteps(action, details);
  }
  if (action === "CHOOSE_DIFFERENT_KEY") {
    return chooseDifferentSteps(action, details);
  }
  switch (action) {
    case "USE_CANONICAL_ID":
      return [
        message(
          "assistant",
          "Choose the intended candidate from details.candidates, then retry the original operation with that candidate's canonical ID.",
        ),
      ];
    case "CREATE_NEW_RUN":
      return [
        toolMessage(
          "flags_get",
          `Get the affected flagId=${flagId} and retain its key for the final test evaluation.`,
        ),
        toolMessage(
          "experiments_create",
          "Clone into a new draft Run (the change is frozen on the current Run).",
        ),
        message(
          "assistant",
          "Apply the blocked change on the new draft (use the same write the original call attempted).",
        ),
        toolMessage("experiments_start", "Start the new draft Run."),
        toolMessage(
          "flags_test_eval",
          "Use the Flag key returned by flags_get. Require liveRunId to equal the Run id returned by experiments_start; stop with an identity-mismatch error otherwise.",
        ),
      ];
    case "END_RUNNING_RUN_FIRST": {
      const runningRunId =
        typeof details.runningRunId === "string" ? details.runningRunId : "<runningRunId>";
      return [
        toolMessage("runs_end", `End the running Run ${runningRunId}.`),
        message("assistant", "Retry the original operation after the Run has Ended."),
      ];
    }
    case "START_A_RUN":
      return [
        toolMessage(
          "experiments_start",
          "Start a Run (create the Experiment first with experiments_create when none exists).",
        ),
        message("assistant", "Retry the original operation after the Run is running."),
      ];
    case "EDIT_DRAFT_THEN_START":
      return [
        message("assistant", "Apply a draft change (the draft currently matches the live Run)."),
        toolMessage("experiments_start", "Start the updated draft."),
      ];
    case "ADD_VARIANT_TO_ENV":
      return [
        toolMessage(
          "flags_promote",
          "Promote the missing Variant into the Environment, then retry the original operation.",
        ),
        message("assistant", "Retry the original operation after promotion."),
      ];
    case "RETRY_AFTER": {
      const retryAfterMs =
        typeof details.retryAfterMs === "number" ? details.retryAfterMs : "<retryAfterMs>";
      return [
        message(
          "assistant",
          `Wait ${retryAfterMs} ms (details.retryAfterMs / Retry-After), then retry the original operation. No tool call is required before the wait.`,
        ),
      ];
    }
    case "READ_PER_ENVIRONMENT": {
      const environments =
        typeof details.environments === "number" ? details.environments : "<environments>";
      return [
        toolMessage(
          "experiments_list",
          `List Experiments one Environment at a time (${environments} Environments) to enumerate the running Experiments in each; the Experiment record itself carries no SRM or Guardrail health.`,
        ),
        message("assistant", "For every running Experiment returned above, fetch its health next."),
        toolMessage(
          "experiment_results_get",
          "Get the Experiment's StatsOutput (srm, guardrail_results) — this is the operation that actually carries SRM and Guardrail health, not experiments_list.",
        ),
        message(
          "assistant",
          "Do not retry the App-wide rollup: the refusal is a fan-out budget, not a transient failure, and only a smaller App shape (or this per-Environment, per-Experiment walk) changes it.",
        ),
      ];
    }
  }
}

function chooseDifferentSteps(
  action: "CHOOSE_DIFFERENT_SLUG" | "CHOOSE_DIFFERENT_KEY",
  details: Record<string, unknown>,
): readonly McpPromptMessage[] {
  if (action === "CHOOSE_DIFFERENT_SLUG") {
    const taken =
      typeof details.conflictingSlug === "string"
        ? `"${details.conflictingSlug}"`
        : "<conflictingSlug>";
    return [
      message(
        "assistant",
        `The URL handle ${taken} is already taken. Resend the same call with a different "slug". No different tool is required.`,
      ),
    ];
  }
  const key = typeof details.key === "string" ? `"${details.key}"` : "<key>";
  const status = typeof details.status === "string" ? details.status : "unknown";
  if (status === "archived") {
    const archivedId =
      typeof details.archivedExperimentId === "string"
        ? details.archivedExperimentId
        : "<archivedExperimentId>";
    return [
      message(
        "assistant",
        `Key ${key} is still held by archived Experiment ${archivedId}. Resend experiments_create with a different "key". Keys are not freed on archive.`,
      ),
    ];
  }
  return [
    message(
      "assistant",
      `Key ${key} is already held by a ${status} Experiment. Resend experiments_create with a different "key".`,
    ),
  ];
}

function approvalRecoverySteps(
  action: "REVIEW_APPROVAL_REQUEST" | "REFRESH_AND_REPROPOSE" | "RETRY_REVIEW",
  details: Record<string, unknown>,
): readonly McpPromptMessage[] {
  const approvalRequestId =
    typeof details.approvalRequestId === "string"
      ? details.approvalRequestId
      : "<approvalRequestId>";

  if (action === "REVIEW_APPROVAL_REQUEST") {
    return [
      toolMessage(
        "approval_request_reviews_create",
        `Review ${approvalRequestId} with the authorized approve_and_apply or decline action.`,
      ),
    ];
  }
  if (action === "REFRESH_AND_REPROPOSE") {
    return [
      toolMessage(
        "approval_requests_get",
        `Read stale request ${approvalRequestId} and its immutable proposal.`,
      ),
      message(
        "assistant",
        "Read the current target with its canonical GET tool, then resubmit the intended mutation with a new idempotency key.",
      ),
    ];
  }
  return [
    toolMessage(
      "approval_request_reviews_create",
      `Retry Review of pending request ${approvalRequestId} with a new idempotency key.`,
    ),
  ];
}

function parseDetails(detailsRaw: unknown): Record<string, unknown> {
  if (detailsRaw === undefined || detailsRaw === null) {
    throw new PromptArgumentError('Prompt argument "details" is required.');
  }
  if (typeof detailsRaw === "string") {
    return parseDetailsJson(detailsRaw);
  }
  if (typeof detailsRaw === "object" && !Array.isArray(detailsRaw)) {
    return detailsRaw as Record<string, unknown>;
  }
  throw new PromptArgumentError('Prompt argument "details" must be an object or a JSON string.');
}

function parseDetailsJson(detailsRaw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailsRaw);
  } catch {
    throw new PromptArgumentError('Prompt argument "details" must be valid JSON.');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PromptArgumentError('Prompt argument "details" must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}
