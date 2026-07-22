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

const RECOMMENDED_ACTION_SET = new Set<string>(recommendedActions);

export function onboardNewAppPlan(orgId: string, appName: string): McpPromptPlan {
  const operationIds = [
    "apps_create",
    "context_use",
    "client_key_get",
    "flags_create",
    "flags_test_eval",
  ] as const;
  return {
    description: promptDescription("onboard_new_app"),
    operationIds,
    messages: [
      message(
        "user",
        `Onboard a new App named ${JSON.stringify(appName)} in Organization ${orgId}. Execute only the tools named below, in order. This plan never mutates by itself.`,
      ),
      toolMessage(
        "apps_create",
        `Create the App under orgId=${orgId} with name=${JSON.stringify(appName)}. The Worker provisions dev and prod Environments.`,
      ),
      toolMessage(
        "context_use",
        "Select the newly provisioned dev Environment (appId + environmentId from apps_create).",
      ),
      toolMessage(
        "client_key_get",
        "Fetch the Client Key for the active App — the credential customer code will hold.",
      ),
      toolMessage(
        "flags_create",
        "Create an initial Flag in the active App so wiring can be confirmed.",
      ),
      toolMessage(
        "flags_test_eval",
        "Run the control-plane confidence round-trip (ADR-0037). Do not treat onboarding as complete until this resolves green. Customer code later uses the Client Key path for the first real Exposure.",
      ),
      message(
        "assistant",
        "If this session authenticated via the anonymous door, tell the human to claim the demo Organization before demoExpiresAt (see splitch://active-context). Onboarding is complete only after the first real Exposure (deploy → evaluate with a real Targeting Key).",
      ),
    ],
  };
}

export function shipAFlagPlan(flagKey: string, variants: string): McpPromptPlan {
  const operationIds = ["flags_create", "flags_promote", "flags_test_eval"] as const;
  return {
    description: promptDescription("ship_a_flag"),
    operationIds,
    messages: [
      message(
        "user",
        `Ship Flag key=${JSON.stringify(flagKey)} with variants=${JSON.stringify(variants)}. Execute only the tools named below, in order.`,
      ),
      toolMessage(
        "flags_create",
        `Create the Flag at App scope with key=${JSON.stringify(flagKey)} and variants=${JSON.stringify(variants)}.`,
      ),
      toolMessage("flags_promote", "Promote Variant availability into the active Environment."),
      toolMessage(
        "flags_test_eval",
        "Confirm the rule set resolves in the active Environment (ADR-0037 time-to-first-confidence).",
      ),
    ],
  };
}

export function runAnExperimentPlan(
  flagId: string,
  variants: string,
  allocation: string,
): McpPromptPlan {
  const operationIds = [
    "experiments_create",
    "experiments_start",
    "flags_test_eval",
    "experiment_results_get",
  ] as const;
  return {
    description: promptDescription("run_an_experiment"),
    operationIds,
    messages: [
      message(
        "user",
        `Run an Experiment on flagId=${flagId} with variants=${JSON.stringify(variants)} and allocation=${JSON.stringify(allocation)}. Execute only the tools named below, in order.`,
      ),
      toolMessage(
        "experiments_create",
        `Create the Experiment for flagId=${flagId} with variants=${JSON.stringify(variants)} and allocation=${JSON.stringify(allocation)}.`,
      ),
      toolMessage(
        "experiments_start",
        "Start a Run. Environment Policy may require confirm: true (ADR-0029).",
      ),
      toolMessage(
        "flags_test_eval",
        "Confirm the live Run resolves before treating the Experiment as live (ADR-0037).",
      ),
      toolMessage("experiment_results_get", "Poll results for the running Experiment."),
    ],
  };
}

export function endARunPlan(runId: string): McpPromptPlan {
  const operationIds = ["flags_test_eval", "runs_end"] as const;
  return {
    description: promptDescription("end_a_run"),
    operationIds,
    messages: [
      message("user", `End Run runId=${runId}. Execute only the tools named below, in order.`),
      toolMessage("flags_test_eval", "Capture the current resolution before Ending the Run."),
      toolMessage("runs_end", `End the Run runId=${runId}.`),
      message(
        "assistant",
        "Confirm the Run is no longer running (RUN_NOT_RUNNING is the expected state for further running-only ops).",
      ),
    ],
  };
}

export function diagnoseSetupPlan(): McpPromptPlan {
  const operationIds = ["client_key_get", "flags_test_eval"] as const;
  return {
    description: promptDescription("diagnose_setup"),
    operationIds,
    messages: [
      message(
        "user",
        "Diagnose whether the active session is wired for Flag evaluation. Execute only the tools named below, in order.",
      ),
      message(
        "assistant",
        "Read splitch://active-context to resolve the active App, Environment, and source (session). Do not invent scope.",
      ),
      toolMessage("client_key_get", "Fetch the Client Key for the active App."),
      toolMessage(
        "flags_test_eval",
        "Confirm a known Flag resolves in the active Environment (ADR-0037). Report what is and is not wired.",
      ),
    ],
  };
}

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
