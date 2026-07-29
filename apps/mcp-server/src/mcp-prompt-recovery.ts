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

export function recoverFromErrorPlan(errorCode: string, detailsRaw: unknown): McpPromptPlan {
  const details = parseDetails(detailsRaw);
  const recommendedAction = details.recommendedAction;
  if (typeof recommendedAction !== "string" || !RECOMMENDED_ACTION_SET.has(recommendedAction)) {
    throw new PromptArgumentError(
      `mcp-prompts: recover_from_error requires details.recommendedAction to be one of ${recommendedActions.join(", ")}`,
    );
  }
  const action = recommendedAction as RecommendedAction;
  const operationIds = RECOVERY_OPERATION_IDS[action];
  return {
    description: promptDescription("recover_from_error"),
    operationIds,
    messages: recoveryMessages(errorCode, action, details, operationIds),
  };
}

function recoveryMessages(
  errorCode: string,
  action: RecommendedAction,
  details: Record<string, unknown>,
  operationIds: readonly string[],
): readonly McpPromptMessage[] {
  const messages: McpPromptMessage[] = [
    message(
      "user",
      `Recover from errorCode=${errorCode} with recommendedAction=${action}. Execute only the tools named below, in order. This plan never mutates by itself.`,
    ),
    ...recoverySteps(action, details),
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

function recoverySteps(
  action: RecommendedAction,
  details: Record<string, unknown>,
): readonly McpPromptMessage[] {
  switch (action) {
    case "CREATE_NEW_RUN":
      return [
        toolMessage(
          "experiments_create",
          "Clone into a new draft Run (the change is frozen on the current Run).",
        ),
        message(
          "assistant",
          "Apply the blocked change on the new draft (use the same write the original call attempted).",
        ),
        toolMessage("experiments_start", "Start the new draft Run."),
        toolMessage("flags_test_eval", "Confirm the new Run resolves (ADR-0037)."),
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
    case "RETRY_WITH_CONFIRMATION":
      return [
        message(
          "assistant",
          "Resend the identical call with confirm: true (Environment Policy gate, ADR-0029). No different tool is required.",
        ),
      ];
    case "CHOOSE_DIFFERENT_SLUG": {
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
  }
}

function parseDetails(detailsRaw: unknown): Record<string, unknown> {
  if (detailsRaw === undefined || detailsRaw === null) {
    throw new PromptArgumentError('mcp-prompts: argument "details" is required');
  }
  if (typeof detailsRaw === "string") {
    return parseDetailsJson(detailsRaw);
  }
  if (typeof detailsRaw === "object" && !Array.isArray(detailsRaw)) {
    return detailsRaw as Record<string, unknown>;
  }
  throw new PromptArgumentError("mcp-prompts: details must be an object or JSON string");
}

function parseDetailsJson(detailsRaw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailsRaw);
  } catch {
    throw new PromptArgumentError("mcp-prompts: details must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PromptArgumentError("mcp-prompts: details must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
