import { readdir, readFile } from "node:fs/promises";
import { getRoute } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { controlPlaneSdkForRoute, handleMcpServerRequest } from "./mcp-handler";
import type { OperationSdk } from "./mcp-operation-sdks";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";

/**
 * SPL-313: MCP dispatched by `route.owner`, so Analysis- and Evaluation-owned
 * tools reached those Workers directly and never met the Control Plane's D1
 * membership, Environment-scope, and Policy gates. MCP now has exactly one
 * downstream. These checks fail if it regains a second one, by binding or by
 * dispatch, because either would reopen the bypass without breaking a tool.
 */

const SOURCE_ROOT = new URL("./", import.meta.url);
const WRANGLER_CONFIG = new URL("../wrangler.jsonc", import.meta.url);

const organizationUsage = {
  organizationId: "org_local",
  period: {
    month: "2026-07",
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-07-31T23:59:59.999Z",
  },
  state: "zero",
  evaluations: 0,
  breakdown: {
    byApp: [],
    byEnvironment: [],
    byFlag: [],
    bySdkRuntime: [],
    byBatch: [],
    bySource: [],
    byExposure: [],
  },
};

describe("MCP has only the Control Plane downstream", () => {
  it("sends an Analysis-owned tool to the Control Plane", async () => {
    const seen: string[] = [];
    const response = await handleMcpServerRequest({
      request: toolCall("organization_usage_get", { orgId: "org_local" }),
      service: "splitch-mcp-server",
      platformTarget: "local",
      controlPlaneBaseUrl: "http://control-plane.test",
      controlPlaneFetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.origin}${url.pathname}`);
        return Response.json(organizationUsage);
      },
      controlPlaneDelegationSecret: TEST_MCP_DELEGATION_SECRET,
      tokenVerifier: staticMcpTokenVerifier(),
      revocations: allowMcpRevocations(),
    });
    const body = (await response.json()) as {
      result: { structuredContent: unknown; isError?: boolean };
    };

    expect(seen).toEqual(["GET http://control-plane.test/orgs/org_local/usage"]);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toEqual(organizationUsage);
  });

  it("refuses to acquire a downstream for a route addressed at another surface", () => {
    const evaluationAddressed = getRoute("sdk_evaluate");
    const controlPlaneAddressed = getRoute("organization_usage_get");
    if (!evaluationAddressed || !controlPlaneAddressed) throw new Error("missing route contract");
    const sdk = {} as OperationSdk;

    expect(() => controlPlaneSdkForRoute(() => sdk, evaluationAddressed)).toThrow(
      /is addressed at evaluation-api, not the Control Plane/,
    );
    expect(controlPlaneSdkForRoute(() => sdk, controlPlaneAddressed)).toBe(sdk);
  });

  it("declares no Analysis or Evaluation service binding in any environment", async () => {
    const config = await readFile(WRANGLER_CONFIG, "utf8");
    const bindings = [...config.matchAll(/"binding": "(\w+)",\s*"service": "([\w-]+)"/g)].map(
      (match) => ({ binding: match[1], service: match[2] }),
    );

    expect(bindings.length).toBeGreaterThan(0);
    for (const { binding, service } of bindings) {
      expect(binding).toBe("CONTROL_PLANE_API");
      expect(service).toMatch(/^splitch-control-plane-api(-[\w-]+)?$/);
    }
  });

  it("never reads a route owner in the source it dispatches from", async () => {
    const sources = await readSources();

    // The scan is worthless if it misses the dispatch site, so name it.
    const dispatch = sources.get("mcp-handler.ts");
    expect(dispatch).toBeDefined();
    expect(dispatch).toContain("controlPlaneSdkForRoute");
    expect(dispatch).toContain("callOperationById");

    for (const [name, source] of sources) {
      expect(stripComments(source), `${name} reads a route owner`).not.toMatch(/\.owner\b/);
      expect(source, `${name} names an Analysis or Evaluation binding`).not.toMatch(
        /\b(ANALYSIS_API|EVALUATION_API)\b/,
      );
    }
  });
});

/** Every non-test module under the MCP source root: apps/mcp-server/src. */
async function readSources(): Promise<Map<string, string>> {
  const names = (await readdir(SOURCE_ROOT)).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  const sources = new Map<string, string>();
  for (const name of names) {
    sources.set(name, await readFile(new URL(name, SOURCE_ROOT), "utf8"));
  }
  return sources;
}

/** A comment can explain the removed owner dispatch; only code may not do it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function toolCall(name: string, arguments_: Record<string, unknown>): Request {
  return new Request("https://mcp.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer local-test-token", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
}
