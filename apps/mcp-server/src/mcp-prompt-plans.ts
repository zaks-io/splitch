import { type McpPromptPlan, message, promptDescription, toolMessage } from "./mcp-prompt-types";

export function onboardNewAppPlan(orgId: string, appName: string): McpPromptPlan {
  const operationIds = [
    "apps_create",
    "context_use",
    "client_key_get",
    "flags_create",
    "flag_config_update",
    "experiments_create",
    "experiments_start",
    "flags_test_eval",
    "experiment_results_get",
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
        "flag_config_update",
        "Enable the Flag and make its Control and Treatment Variants available in dev.",
      ),
      toolMessage(
        "experiments_create",
        "Create the smallest Experiment draft around the Flag: metrics=[], explicit allocation, Targeting Key field and type.",
      ),
      toolMessage(
        "experiments_start",
        "Start the first Run with a caller-stable idempotency_key. Do not create an Approval Request unless Environment Policy requires it.",
      ),
      toolMessage(
        "flags_test_eval",
        "Confirm the live Run resolves without recording an Exposure (ADR-0037). Customer code then evaluates once through the SDK and retries with the same idempotency key.",
      ),
      toolMessage(
        "experiment_results_get",
        "After the SDK Evaluation, poll until deduped Exposure counts total exactly one, multiple_count is zero, and __multiple__ is absent.",
      ),
      message(
        "assistant",
        "If this session authenticated via the anonymous door, tell the human to claim the demo Organization before demoExpiresAt (see splitch://active-context). Onboarding is complete only after experiment_results_get observes the first real, deduplicated Exposure.",
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
