import { beforeAll, describe, expect, it } from "vitest";
import type { ControlPlaneApiEnv } from "../src/env.js";
import {
  callMcpTool,
  recordingBinding,
  setupMcpDoorTestEnv,
  TENANT_A,
  TENANT_B,
} from "./index-mcp-fixtures.js";

let testEnv: ControlPlaneApiEnv;

beforeAll(async () => {
  testEnv = await setupMcpDoorTestEnv();
});

describe("index.ts: widened MCP routes cross the service-binding boundary", () => {
  it.each([
    {
      operationId: "experiment_results_post",
      ownArguments: {
        appId: TENANT_A.appId,
        environmentId: TENANT_A.environmentId,
        experimentId: TENANT_A.experimentId,
      },
      foreignArguments: {
        appId: TENANT_B.appId,
        environmentId: TENANT_B.environmentId,
        experimentId: TENANT_B.experimentId,
      },
      expected: {
        state: "no_data",
        run_id: TENANT_A.runId,
        control_variant: "alpha-control",
        missing: "metric_events",
      },
      owner: "analysis" as const,
    },
    {
      operationId: "flags_test_eval",
      ownArguments: {
        appId: TENANT_A.appId,
        environmentId: TENANT_A.environmentId,
        flagKey: TENANT_A.flagKey,
        evaluationContext: {
          targetingKey: "tenant-alpha-user",
          idType: "user",
          attributes: { plan: "alpha" },
        },
      },
      foreignArguments: {
        appId: TENANT_B.appId,
        environmentId: TENANT_B.environmentId,
        flagKey: TENANT_B.flagKey,
        evaluationContext: {
          targetingKey: "tenant-beta-user",
          idType: "user",
          attributes: { plan: "beta" },
        },
      },
      expected: {
        variantName: "alpha-treatment",
        value: true,
        resolutionReason: "DEFAULT",
        reason: { type: "no_match_default" },
        liveRunId: null,
      },
      owner: "evaluation" as const,
    },
  ])(
    "accepts own-tenant $operationId through the real MCP door and refuses another tenant",
    async ({ operationId, ownArguments, foreignArguments, expected, owner }) => {
      const analysisRequests: Request[] = [];
      const evaluationRequests: Request[] = [];
      const envWithOrigins = {
        ...testEnv,
        ANALYSIS_API: recordingBinding(analysisRequests, {
          state: "no_data",
          run_id: TENANT_A.runId,
          control_variant: "alpha-control",
          missing: "metric_events",
        }),
        EVALUATION_API: recordingBinding(evaluationRequests, {
          variantName: "alpha-treatment",
          value: true,
          resolutionReason: "DEFAULT",
          reason: { type: "no_match_default" },
          liveRunId: null,
        }),
      } as ControlPlaneApiEnv;

      const own = await callMcpTool(envWithOrigins, operationId, ownArguments);
      expect(own).toMatchObject({ result: { structuredContent: expected } });
      expect(owner === "analysis" ? analysisRequests : evaluationRequests).toHaveLength(1);

      analysisRequests.length = 0;
      evaluationRequests.length = 0;
      const foreign = await callMcpTool(envWithOrigins, operationId, foreignArguments);
      expect(foreign).toMatchObject({
        result: {
          isError: true,
          structuredContent: { code: "FORBIDDEN" },
        },
      });
      expect(analysisRequests).toHaveLength(0);
      expect(evaluationRequests).toHaveLength(0);
    },
  );
});
