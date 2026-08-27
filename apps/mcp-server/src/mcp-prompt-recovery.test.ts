import { deriveMcpProtocolTools, ErrorResponseSchema } from "@splitch/contracts";
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

    // experiment_results_get's 200 body is AnalysisResultsEnvelope. The ready
    // branch carries StatsOutput on `stats` (SRM/Guardrail health); no_data does
    // not invent zeros.
    const resultsSchema = resultsTool.outputSchema as unknown as JsonSchemaLike;
    const readyBranch = resultsSchema.oneOf?.find(
      (branch) => branch.properties?.state?.const === "ready",
    );
    const statsSchema = readyBranch?.properties?.stats ?? resultsSchema.properties?.stats;
    expect(statsSchema?.properties).toHaveProperty("srm");
    expect(statsSchema?.properties).toHaveProperty("guardrail_results");
  });
});

interface JsonSchemaLike {
  properties?: Record<string, JsonSchemaLike & { const?: string }>;
  items?: JsonSchemaLike;
  oneOf?: JsonSchemaLike[];
}
