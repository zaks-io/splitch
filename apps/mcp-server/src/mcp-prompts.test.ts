import { type RecommendedAction, recommendedActions } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { handleMcpServerRequest } from "./mcp-handler";
import { MCP_PROMPT_NAMES, RECOVERY_OPERATION_IDS } from "./mcp-prompt-types";
import {
  allPromptPlans,
  assertAllPromptOperationIds,
  assertPromptOperationIds,
  getMcpPrompt,
  getPromptPlan,
  listMcpPrompts,
  s08DerivedToolNames,
} from "./mcp-prompts";
import type {
  McpSessionContext,
  McpSessionStore,
  McpSessionTransport,
} from "./mcp-session-context";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

const service = "splitch-mcp-server";
const defaultAuthorization = "Bearer local-test-token";

describe("MCP prompts workflows", () => {
  it("lists the six plan-template prompts", async () => {
    const response = await mcp("prompts/list");
    const body = (await response.json()) as JsonRpcSuccess<{
      prompts: Array<{ name: string }>;
    }>;

    expect(response.status).toBe(200);
    expect(body.result.prompts.map((prompt) => prompt.name)).toEqual([...MCP_PROMPT_NAMES]);
    expect(listMcpPrompts().prompts).toHaveLength(6);
  });

  it("advertises prompts capability on initialize", async () => {
    const response = await mcp("initialize");
    const body = (await response.json()) as JsonRpcSuccess<{
      capabilities: { prompts?: { listChanged: boolean } };
    }>;

    expect(body.result.capabilities.prompts).toEqual({ listChanged: false });
  });

  it("every operationId in every prompt exists in the S08-derived tool set", () => {
    const known = s08DerivedToolNames();
    expect(known.has("context_use")).toBe(true);
    expect(known.has("flags_test_eval")).toBe(true);
    expect(known.has("apps_create")).toBe(true);

    expect(() => assertAllPromptOperationIds(known)).not.toThrow();

    for (const plan of allPromptPlans()) {
      expect(plan.operationIds.length).toBeGreaterThanOrEqual(0);
      for (const operationId of plan.operationIds) {
        expect(known.has(operationId), `${operationId} missing from S08 tools`).toBe(true);
      }
      // Messages name tools with Call `operationId`: and must match the plan order.
      const named = plan.messages
        .map((entry) => /^Call `([a-z][a-z0-9_]*)`:/.exec(entry.content.text)?.[1])
        .filter((id): id is string => id !== undefined);
      expect(named).toEqual([...plan.operationIds]);
    }
  });

  it("fails loudly when a prompt references a nonexistent operationId", () => {
    const known = s08DerivedToolNames();
    expect(() => assertPromptOperationIds(["flags_list", "does_not_exist_tool"], known)).toThrow(
      /does_not_exist_tool/,
    );
    expect(() => assertPromptOperationIds(["flags_list"], known)).not.toThrow();
  });

  it("each prompt returns a message sequence with no mutation", async () => {
    const sessionStore = trackingSessionStore();
    const sessionId = await initializeSession(sessionStore);
    const writesBefore = sessionStore.writes;

    const cases: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: "onboard_new_app", arguments: { orgId: "org_demo", appName: "Demo App" } },
      { name: "ship_a_flag", arguments: { flagKey: "checkout", variants: "on,off" } },
      {
        name: "run_an_experiment",
        arguments: { flagId: "flag_checkout", variants: "a,b", allocation: "50,50" },
      },
      { name: "end_a_run", arguments: { runId: "run_1" } },
      {
        name: "recover_from_error",
        arguments: {
          errorCode: "EXPERIMENT_RUNNING",
          details: { recommendedAction: "END_RUNNING_RUN_FIRST", runningRunId: "run_live" },
        },
      },
      { name: "diagnose_setup", arguments: {} },
    ];

    for (const prompt of cases) {
      const response = await mcp("prompts/get", prompt, { sessionId, sessionStore });
      const body = (await response.json()) as JsonRpcSuccess<{
        description: string;
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      }>;

      expect(response.status).toBe(200);
      expect(body.result.messages.length).toBeGreaterThan(0);
      expect(body.result.messages.every((entry) => entry.content.type === "text")).toBe(true);
      expect(sessionStore.writes).toBe(writesBefore);
    }

    // Direct getPrompt path also performs no writes.
    const directWrites = sessionStore.writes;
    getMcpPrompt("onboard_new_app", { orgId: "org_demo", appName: "Demo App" });
    expect(sessionStore.writes).toBe(directWrites);
  });

  it("recover_from_error returns the documented step sequence for each recommendedAction", () => {
    for (const action of recommendedActions) {
      const plan = getPromptPlan("recover_from_error", {
        errorCode: "EXPERIMENT_RUNNING",
        details: {
          recommendedAction: action,
          runningRunId: "run_live",
          retryAfterMs: 250,
        },
      });
      expect(plan.operationIds).toEqual([...RECOVERY_OPERATION_IDS[action as RecommendedAction]]);
    }

    expect(RECOVERY_OPERATION_IDS.CREATE_NEW_RUN).toEqual([
      "experiments_create",
      "experiments_start",
      "flags_test_eval",
    ]);
    expect(RECOVERY_OPERATION_IDS.END_RUNNING_RUN_FIRST).toEqual(["runs_end"]);
    expect(RECOVERY_OPERATION_IDS.START_A_RUN).toEqual(["experiments_start"]);
    expect(RECOVERY_OPERATION_IDS.EDIT_DRAFT_THEN_START).toEqual(["experiments_start"]);
    expect(RECOVERY_OPERATION_IDS.ADD_VARIANT_TO_ENV).toEqual(["flags_promote"]);
    expect(RECOVERY_OPERATION_IDS.RETRY_AFTER).toEqual([]);
    expect(RECOVERY_OPERATION_IDS.RETRY_WITH_CONFIRMATION).toEqual([]);
  });

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
      "flags_test_eval",
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
    const end = getPromptPlan("end_a_run", { runId: "run_1" });
    const diagnose = getPromptPlan("diagnose_setup");

    expect(onboard.operationIds).toContain("flags_test_eval");
    expect(onboard.operationIds).toContain("context_use");
    expect(ship.operationIds.at(-1)).toBe("flags_test_eval");
    expect(run.operationIds).toContain("flags_test_eval");
    expect(end.operationIds[0]).toBe("flags_test_eval");
    expect(diagnose.operationIds.at(-1)).toBe("flags_test_eval");
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

async function initializeSession(sessionStore: McpSessionStore): Promise<string> {
  const response = await mcp("initialize", undefined, { sessionStore });
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function mcp(
  method: string,
  params?: unknown,
  options: {
    authorization?: string;
    sessionId?: string;
    sessionStore?: McpSessionStore;
  } = {},
): Promise<Response> {
  return handleMcpServerRequest({
    request: new Request("https://mcp.test/mcp", {
      method: "POST",
      headers: {
        authorization: options.authorization ?? defaultAuthorization,
        "content-type": "application/json",
        ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    service,
    platformTarget: "local",
    tokenVerifier: staticMcpTokenVerifier({
      subject: "user_local_test",
      scopes: ["app:app_local:admin"],
      authDoor: "id_jag",
    }),
    revocations: allowMcpRevocations(),
    controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
    controlPlaneFetch: async () => {
      throw new Error("prompts must not call the control plane");
    },
    evaluationFetch: async () => {
      throw new Error("prompts must not call evaluation");
    },
    analysisFetch: async () => {
      throw new Error("prompts must not call analysis");
    },
    sessionStore: options.sessionStore ?? trackingSessionStore(),
  });
}

function trackingSessionStore(): McpSessionStore & { writes: number } {
  const sessions = new Map<
    string,
    { context?: McpSessionContext; transport?: McpSessionTransport }
  >();
  return {
    writes: 0,
    async create(transport) {
      this.writes += 1;
      const id = crypto.randomUUID();
      sessions.set(id, { transport });
      return id;
    },
    async get(id) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      return sessions.get(id)?.context;
    },
    async getTransport(id) {
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      return sessions.get(id)?.transport;
    },
    async set(id, context) {
      this.writes += 1;
      if (!sessions.has(id)) throw new Error("mcp-server: MCP session is unknown or expired");
      const record = sessions.get(id);
      sessions.set(id, { ...record, context });
    },
    async end(id) {
      this.writes += 1;
      sessions.delete(id);
    },
  };
}

interface JsonRpcSuccess<T> {
  result: T;
}
