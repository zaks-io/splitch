import { describe, expect, it } from "vitest";
import { allPromptPlans, getPromptPlan, listMcpPrompts } from "./mcp-prompts";

describe("MCP prompt plan shapes", () => {
  it("onboard_new_app ends by telling a human to claim an anon-door demo Org", () => {
    const plan = getPromptPlan("onboard_new_app", {
      orgId: "org_demo",
      appName: "Demo App",
    });
    const closing = plan.messages[plan.messages.length - 1]?.content.text ?? "";
    expect(closing).toMatch(/claim/i);
    expect(closing).toMatch(/demoExpiresAt/);
    expect(plan.operationIds).toEqual([
      "apps_create",
      "context_use",
      "client_key_get",
      "flags_create",
      "flag_config_update",
      "experiments_create",
      "experiments_start",
      "flags_test_eval",
      "experiment_results_get",
    ]);
  });

  it("workflow prompts close on a flags_test_eval confidence round-trip", () => {
    const onboard = getPromptPlan("onboard_new_app", {
      orgId: "org_demo",
      appName: "Demo App",
    });
    const ship = getPromptPlan("ship_a_flag", { flagKey: "checkout", variants: "on,off" });
    const run = getPromptPlan("run_an_experiment", {
      flagId: "flag_checkout",
      variants: "a,b",
      allocation: "50,50",
    });
    const end = getPromptPlan("end_a_run", { runId: "run_1", experimentId: "exp_1" });
    const diagnose = getPromptPlan("diagnose_setup", { flagKey: "checkout" });

    expect(onboard.operationIds).toContain("flags_test_eval");
    expect(onboard.operationIds).toContain("context_use");
    expect(ship.operationIds.at(-1)).toBe("flags_test_eval");
    expect(run.operationIds).toContain("flags_test_eval");
    expect(end.operationIds).toContain("flags_test_eval");
    expect(diagnose.operationIds.at(-1)).toBe("flags_test_eval");
  });

  it("gives every flags_test_eval step a usable Flag key source", () => {
    for (const plan of allPromptPlans()) {
      const steps = plan.messages.filter((entry) =>
        entry.content.text.startsWith("Call `flags_test_eval`:"),
      );
      for (const step of steps) {
        expect(step.content.text).toMatch(/flagKey=|Flag key returned by/i);
      }
    }
  });

  it("binds test evaluation to the affected Flag and Run", () => {
    const definitions = listMcpPrompts().prompts;
    for (const name of ["run_an_experiment", "end_a_run"] as const) {
      const definition = definitions.find((prompt) => prompt.name === name);
      expect(definition?.arguments.map((argument) => argument.name)).not.toContain("flagKey");
    }

    const run = getPromptPlan("run_an_experiment", {
      flagId: "flag_checkout",
      variants: "a,b",
      allocation: "50,50",
    });
    const end = getPromptPlan("end_a_run", { runId: "run_1", experimentId: "exp_1" });
    for (const plan of [run, end]) {
      const step = plan.messages.find((entry) =>
        entry.content.text.startsWith("Call `flags_test_eval`:"),
      );
      expect(step?.content.text).toMatch(/Require liveRunId/);
      expect(plan.operationIds).toContain("flags_get");
    }
  });

  it("fails loudly when CREATE_NEW_RUN recovery cannot identify the Flag", () => {
    expect(() =>
      getPromptPlan("recover_from_error", {
        errorCode: "RUN_FROZEN",
        details: { recommendedAction: "CREATE_NEW_RUN", currentRunId: "run_1" },
      }),
    ).toThrow(/requires prompt argument "flagId"/);

    const plan = getPromptPlan("recover_from_error", {
      errorCode: "RUN_FROZEN",
      details: { recommendedAction: "CREATE_NEW_RUN", currentRunId: "run_1" },
      flagId: "flag_checkout",
    });
    expect(plan.operationIds[0]).toBe("flags_get");
    expect(plan.messages.some((entry) => entry.content.text.includes("flag_checkout"))).toBe(true);
  });

  it("accepts recover_from_error details as a JSON string", () => {
    const plan = getPromptPlan("recover_from_error", {
      errorCode: "RATE_LIMITED",
      details: JSON.stringify({ recommendedAction: "RETRY_AFTER", retryAfterMs: 500 }),
    });
    expect(plan.operationIds).toEqual([]);
    expect(plan.messages.some((entry) => entry.content.text.includes("500"))).toBe(true);
  });
});
