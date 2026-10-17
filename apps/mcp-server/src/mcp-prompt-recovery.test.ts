import { deriveMcpProtocolTools, deriveMcpTools, ErrorResponseSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { getPromptPlan } from "./mcp-prompts";

/**
 * Split out of mcp-prompts.test.ts for file size: the attention fan-out
 * recovery is the one plan whose recommended tool chain has to be proven
 * against the real route output contracts, not just against its own prose.
 */

describe("MCP recover_from_error attention fan-out", () => {
  // The attention rollup refuses an oversized fan-out with a 409 that no retry can
  // clear, so the recovery plan has to route the caller to the per-Environment read
  // and say plainly that retrying is not the remediation.
  it("recovers an attention fan-out refusal into the per-Environment read", () => {
    // Parsed through the contract, so the plan is driven by the same details the
    // handler is allowed to emit rather than by a hand-shaped object.
    const error = ErrorResponseSchema.parse({
      code: "ATTENTION_FANOUT_LIMIT_EXCEEDED",
      message: "attention rollup spans 240 Environments, above the 200 limit",
      details: {
        appId: "app_checkout",
        limit: 200,
        environments: 240,
        runningExperiments: null,
        recommendedAction: "READ_PER_ENVIRONMENT",
      },
    });

    const plan = getPromptPlan("recover_from_error", {
      errorCode: error.code,
      details: error.details,
    });

    expect(plan.operationIds).toEqual(["experiments_list", "experiment_results_get"]);
    const text = plan.messages.map((entry) => entry.content.text).join("\n");
    expect(text).toContain("240");
    expect(text).toMatch(/Do not retry/i);
  });

  // The recovery text CLAIMS experiment_results_get is what actually carries
  // SRM/Guardrail health (and that experiments_list does not). Prove that
  // against the real route contracts, not just the prose: experiments_list's
  // 200 body must NOT expose srm/guardrail fields, and experiment_results_get's
  // 200 body (StatsOutput) must.
  it("the recommended READ_PER_ENVIRONMENT operations' output contracts actually carry SRM/Guardrail health", () => {
    const tools = deriveMcpProtocolTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool] as const));

    const listTool = byName.get("experiments_list");
    const resultsTool = byName.get("experiment_results_get");
    if (!listTool || !resultsTool) {
      throw new Error("experiments_list / experiment_results_get missing from derived tool set");
    }

    // experiments_list's 200 body is ListResponse<Experiment>; the Experiment
    // element schema carries no srm/guardrail_results health fields.
    const listSchema = listTool.outputSchema as unknown as JsonSchemaLike;
    const experimentSchema = listSchema.properties?.items?.items;
    expect(experimentSchema?.properties).not.toHaveProperty("srm");
    expect(experimentSchema?.properties).not.toHaveProperty("guardrail_results");

    // experiment_results_get's 200 body is the Control Plane producer envelope.
    // The ready branch carries StatsOutput on `stats` (SRM/Guardrail health);
    // no_data does not invent zeros. Zod unions may emit oneOf or anyOf.
    const resultsSchema = resultsTool.outputSchema as unknown as JsonSchemaLike;
    const readyBranch = [...(resultsSchema.oneOf ?? []), ...(resultsSchema.anyOf ?? [])].find(
      (branch) => branch.properties?.state?.const === "ready",
    );
    const statsSchema = readyBranch?.properties?.stats ?? resultsSchema.properties?.stats;
    expect(statsSchema?.properties).toHaveProperty("srm");
    expect(statsSchema?.properties).toHaveProperty("guardrail_results");
  });
});

describe("MCP recover_from_error Temporary Environments", () => {
  it("replaces an expired Environment using the supported create tool and CLI flags", () => {
    const error = ErrorResponseSchema.parse({
      code: "ENVIRONMENT_EXPIRED",
      message: "Temporary Environment has expired",
      details: {
        environmentId: "env_expired",
        expiredAt: "2026-10-17T12:00:00Z",
        recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT",
      },
    });
    const plan = getPromptPlan("recover_from_error", {
      errorCode: error.code,
      details: error.details,
    });
    expect(plan.operationIds).toEqual(["environments_list", "environments_create"]);
    const text = plan.messages.map((entry) => entry.content.text).join("\n");
    expect(text).toContain("splitch envs list");
    expect(text).toContain(
      "splitch envs create --key <new-key> --temporary --from <source-environment>",
    );
    expect(text).toContain("fromEnvironmentId");
    expect(text).toContain("cannot be extended");
    expect(text).toContain("replacement Environment and its credentials");

    const create = deriveMcpTools().find((tool) => tool.name === "environments_create");
    expect(create).toBeDefined();
    expect(
      create?.inputSchema.parse({
        appId: "app_checkout",
        key: "replacement",
        temporary: { fromEnvironmentId: "env_prod" },
      }),
    ).toMatchObject({ temporary: { fromEnvironmentId: "env_prod" } });
  });

  it("frees live capacity by deleting only a selected Temporary Environment", () => {
    const error = ErrorResponseSchema.parse({
      code: "TEMPORARY_ENVIRONMENT_LIMIT_EXCEEDED",
      message: "App has 50 live Temporary Environments",
      details: {
        appId: "app_checkout",
        limit: 50,
        active: 50,
        nextExpiresAt: "2026-10-18T12:00:00Z",
        recommendedAction: "DELETE_TEMPORARY_ENVIRONMENT",
      },
    });
    const plan = getPromptPlan("recover_from_error", {
      errorCode: error.code,
      details: error.details,
    });
    expect(plan.operationIds).toEqual(["environments_list", "environments_delete"]);
    const text = plan.messages.map((entry) => entry.content.text).join("\n");
    expect(text).toContain("splitch envs list");
    expect(text).toContain("temporary !== null");
    expect(text).toContain("never choose a permanent Environment");
    expect(text).toContain("splitch envs delete --env <temporary-environment>");
    expect(text).toContain("Retry the original create after teardown completes");
  });
});

interface JsonSchemaLike {
  properties?: Record<string, JsonSchemaLike & { const?: string }>;
  items?: JsonSchemaLike;
  oneOf?: JsonSchemaLike[];
  anyOf?: JsonSchemaLike[];
}
