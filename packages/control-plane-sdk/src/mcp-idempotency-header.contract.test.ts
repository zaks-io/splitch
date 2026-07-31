import { deriveMcpProtocolTools, isMcpToolRoute, routeRegistry } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { captureOutboundRequest } from "./idempotency-probe-capture";
import { createMcpOperationAdapter } from "./mcp-operation-adapter";

/**
 * SPL-266 regression contract: the MCP twin of `idempotency-header.contract.test.ts`.
 *
 * The typed SDK clients and the MCP adapter are two clients for one rule. The SDK
 * side threw locally on a missing key while the MCP side silently shipped a request
 * the Worker could only reject — and for the body-less DELETE routes the derived tool
 * schema forbade the very field the adapter reads, so the agent had no remedy at all
 * (ADR-0036). This table is exhaustive BY CONSTRUCTION over `routeRegistry`, so a
 * route newly flipped to `idempotency: "required"` cannot ship without an MCP probe.
 */

const BASE_URL = "https://control-plane.test";
const KEY = "idem_mcp_contract_probe";
const APP = "app_probe";
const ENV = "env_probe";
const FLAG = "flag_probe";

/** Flat MCP tool input per required route, each carrying the key the tool schema advertises. */
const probes: Record<string, Record<string, unknown>> = {
  flags_create: {
    appId: APP,
    name: "Probe",
    key: "probe",
    schema: null,
    variants: [{ name: "on", value: true, isDefault: true }],
    idempotency_key: KEY,
  },
  flags_delete: { appId: APP, flagId: FLAG, idempotency_key: KEY },
  flag_variants_create: {
    appId: APP,
    flagId: FLAG,
    name: "off",
    value: false,
    idempotency_key: KEY,
  },
  flag_variants_update: {
    appId: APP,
    flagId: FLAG,
    variantName: "off",
    description: "probe",
    idempotency_key: KEY,
  },
  flag_variants_delete: { appId: APP, flagId: FLAG, variantName: "off", idempotency_key: KEY },
  flag_config_update: {
    appId: APP,
    environmentId: ENV,
    flagId: FLAG,
    enabled: true,
    idempotency_key: KEY,
  },
  flag_targeting_rules_replace: {
    appId: APP,
    environmentId: ENV,
    flagId: FLAG,
    targetingRules: [],
    idempotency_key: KEY,
  },
  flags_promote: {
    appId: APP,
    targetEnvironmentId: ENV,
    flagId: FLAG,
    fromEnvironmentId: "env_source",
    select: { enabled: true },
    idempotency_key: KEY,
  },
  experiments_start: {
    appId: APP,
    environmentId: ENV,
    experimentId: "exp_probe",
    idempotency_key: KEY,
  },
  approval_request_reviews_create: {
    appId: APP,
    id: `apr_${"0".repeat(26)}`,
    action: "decline",
    reason: "probe",
    idempotency_key: KEY,
  },
};

const requiredMcpOperations = routeRegistry
  .filter((route) => route.idempotency === "required" && isMcpToolRoute(route))
  .map((route) => route.operationId);

const toolSchemas = new Map(
  deriveMcpProtocolTools().map((tool) => [tool.name, tool.inputSchema as JsonObjectSchema]),
);

interface JsonObjectSchema {
  properties?: Record<string, unknown>;
  required?: string[];
}

describe("mcp adapter idempotency header contract", () => {
  it("probes every required-idempotency MCP tool", () => {
    const unprobed = requiredMcpOperations.filter((id) => !(id in probes));
    expect(
      unprobed,
      `these routes declare idempotency: "required" but no MCP probe proves the adapter sends the Idempotency-Key header`,
    ).toEqual([]);
  });

  it.each(requiredMcpOperations)("%s advertises idempotency_key as a required field", (id) => {
    const schema = toolSchemas.get(id);
    expect(Object.keys(schema?.properties ?? {})).toContain("idempotency_key");
    expect(schema?.required ?? []).toContain("idempotency_key");
  });

  it.each(requiredMcpOperations)("%s sends the Idempotency-Key header", async (id) => {
    const request = await captureRequest(id, requiredProbe(id));
    expect(request.headers.get("idempotency-key")).toBe(KEY);
  });

  it.each(requiredMcpOperations)("%s fails loud when the key is missing", async (id) => {
    const { idempotency_key: _omitted, ...withoutKey } = requiredProbe(id);
    await expect(captureRequest(id, withoutKey)).rejects.toThrow(
      `control-plane-sdk: ${id} requires an idempotency key`,
    );
  });
});

function requiredProbe(id: string): Record<string, unknown> {
  const probe = probes[id];
  if (!probe) throw new Error(`no MCP probe for "${id}"`);
  return probe;
}

function captureRequest(operationId: string, input: unknown): Promise<Request> {
  return captureOutboundRequest((fetchImpl) =>
    createMcpOperationAdapter({ baseUrl: BASE_URL, fetch: fetchImpl }).callOperationById(
      operationId,
      input,
    ),
  );
}
