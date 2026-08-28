import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { getRoute } from "@splitch/contracts";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";
import { walkRepoFiles } from "../../../scripts/lib/repo-file-sweep.mjs";
import { handleMcpServerRequest } from "./mcp-handler";
import type { OperationSdk } from "./mcp-operation-sdks";
import {
  allowMcpRevocations,
  staticMcpTokenVerifier,
  TEST_MCP_DELEGATION_SECRET,
} from "./mcp-test-verifier";
import { controlPlaneSdkForRoute } from "./mcp-tool-call";

/**
 * SPL-313: MCP dispatched by `route.owner`, so Analysis- and Evaluation-owned
 * tools reached those Workers directly and never met the Control Plane's D1
 * membership, Environment-scope, and Policy gates. MCP now has exactly one
 * downstream. These checks fail if it regains a second one, by binding or by
 * dispatch, because either would reopen the bypass without breaking a tool.
 */

const SOURCE_ROOT = new URL("./", import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MCP_WRANGLER_CONFIG = "apps/mcp-server/wrangler.jsonc";
const wranglerConfig = readWranglerConfig(MCP_WRANGLER_CONFIG);

/**
 * Every Worker config in the checkout. Named rather than counted so a new Worker
 * has to be added here on purpose and the failure names the unexpected config.
 */
const WRANGLER_CONFIGS = [
  "apps/analysis-api/wrangler.jsonc",
  "apps/auth-api/wrangler.jsonc",
  "apps/control-panel/wrangler.jsonc",
  "apps/control-plane-api/wrangler.jsonc",
  "apps/evaluation-api/wrangler.jsonc",
  "apps/event-ingest-api/wrangler.jsonc",
  "apps/marketing/wrangler.jsonc",
  MCP_WRANGLER_CONFIG,
  "packages/cloudflare/wrangler.jsonc",
  "packages/db/wrangler.jsonc",
];

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

  it("declares exactly one Control Plane entrypoint binding in every environment", () => {
    expect(Object.keys(wranglerConfig.env ?? {}).sort()).toEqual(["production", "shared-preview"]);

    const targets = [
      ["local", wranglerConfig, "splitch-control-plane-api"],
      [
        "shared-preview",
        wranglerConfig.env?.["shared-preview"],
        "splitch-control-plane-api-shared-preview",
      ],
      ["production", wranglerConfig.env?.production, "splitch-control-plane-api"],
    ] as const;
    expect(targets).toHaveLength(3);

    for (const [name, target, service] of targets) {
      expect(target, `${name} environment is missing`).toBeDefined();
      expect(target?.services, `${name} service binding set`).toEqual([
        {
          binding: "CONTROL_PLANE_API",
          service,
          entrypoint: "McpEntrypoint",
        },
      ]);
    }
  });

  it("binds McpEntrypoint only from MCP to the Control Plane API", () => {
    const configs = readWranglerConfigs();
    expect(configs.map(({ path }) => path)).toEqual(WRANGLER_CONFIGS);

    const entrypointBindings = configs
      .flatMap(({ path, config }) =>
        [["local", config] as const, ...Object.entries(config.env ?? {})].flatMap(
          ([environment, target]) =>
            (target?.services ?? [])
              .filter((binding) => binding.entrypoint === "McpEntrypoint")
              .map((binding) => ({ path, environment, ...binding })),
        ),
      )
      .sort((left, right) =>
        `${left.path}:${left.environment}`.localeCompare(`${right.path}:${right.environment}`),
      );

    expect(entrypointBindings).toEqual([
      {
        path: MCP_WRANGLER_CONFIG,
        environment: "local",
        binding: "CONTROL_PLANE_API",
        service: "splitch-control-plane-api",
        entrypoint: "McpEntrypoint",
      },
      {
        path: MCP_WRANGLER_CONFIG,
        environment: "production",
        binding: "CONTROL_PLANE_API",
        service: "splitch-control-plane-api",
        entrypoint: "McpEntrypoint",
      },
      {
        path: MCP_WRANGLER_CONFIG,
        environment: "shared-preview",
        binding: "CONTROL_PLANE_API",
        service: "splitch-control-plane-api-shared-preview",
        entrypoint: "McpEntrypoint",
      },
    ]);
  });

  it("never reads a route owner in the source it dispatches from", async () => {
    const sources = await readSources();

    // The scan is worthless if it misses the dispatch site, so name it.
    const dispatch = sources.get("mcp-tool-call.ts");
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
  const root = fileURLToPath(SOURCE_ROOT);
  const sources = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        sources.set(relative(root, path), await readFile(path, "utf8"));
      }
    }
  }

  await visit(root);
  return sources;
}

interface WranglerConfig extends WranglerTarget {
  env?: Record<string, WranglerTarget | undefined>;
}

interface WranglerTarget {
  services?: ServiceBinding[];
}

interface ServiceBinding {
  binding: string;
  service: string;
  entrypoint?: string;
}

/**
 * Walks the checkout rather than asking Git for tracked paths: an untracked
 * `wrangler.jsonc` binding `McpEntrypoint` is a real second caller of the
 * Control Plane's MCP entrypoint, and `git ls-files` cannot see one until
 * somebody stages it.
 */
function readWranglerConfigs(): Array<{ path: string; config: WranglerConfig }> {
  const paths: string[] = [];
  walkRepoFiles(REPO_ROOT, (relativePath) => {
    if (basename(relativePath) === "wrangler.jsonc") paths.push(relativePath);
  });
  return paths.sort().map((path) => ({ path, config: readWranglerConfig(path) }));
}

function readWranglerConfig(relativePath: string): WranglerConfig {
  const path = join(REPO_ROOT, relativePath);
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(String(parsed.error.messageText));
  return parsed.config as WranglerConfig;
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
