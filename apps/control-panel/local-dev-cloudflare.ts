import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginConfig, WorkerConfig } from "@cloudflare/vite-plugin";

const repoRoot = resolve(import.meta.dirname, "../..");
const localNamespaceIds: Record<string, string> = {
  SESSION_STORE: "00000000000000000000000000000000",
  CONFIG_STORE: "local-config-store",
  CREDENTIAL_STORE: "local-credential-store",
  JTI_CACHE: "local-jti-cache",
};
const analysisSourceOrigin = "http://127.0.0.1:18788";
export const localDevServices = {
  "control-plane": ["LOCAL_CONTROL_PLANE", "control-plane-api", 18790],
  analysis: ["LOCAL_ANALYSIS", "analysis-api", 8790],
  evaluation: ["LOCAL_EVALUATION", "evaluation-api", 8788],
  "event-ingest": ["LOCAL_EVENT_INGEST", "event-ingest-api", 8789],
  auth: ["LOCAL_AUTH", "auth-api", 8791],
  mcp: ["LOCAL_MCP", "mcp-server", 8792],
} as const;

const fixtureSecrets: Record<string, string> = {
  SENTRY_DSN: "",
  SPLITCH_DEPLOY_GATE_TOKEN: "local-e2e-deploy-gate",
  SPLITCH_EVENT_INGEST_TOKEN: "local-e2e-event-ingest-token",
  TINYBIRD_READ_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_COPY_TOKEN: "local-e2e-tinybird-copy-token",
  TINYBIRD_DELETE_TOKEN: "local-e2e-tinybird-delete-token",
  TINYBIRD_INGEST_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_RUN_SNAPSHOT_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_APPROVAL_ARCHIVE_WRITE_TOKEN: "local-e2e-tinybird-read-token",
  TINYBIRD_APPROVAL_ARCHIVE_READ_TOKEN: "local-e2e-tinybird-read-token",
  WORKOS_API_KEY: "local-e2e-workos-api-key",
  WORKOS_CLIENT_ID: "local-e2e-workos-client-id",
  CONTROL_PANEL_DELEGATION_SECRET: "local-control-panel-delegation-secret",
};

function localWorkerConfig(
  config: WorkerConfig,
  runId: string,
  gatewayPort: number,
): Partial<WorkerConfig> {
  if (config.vars?.SPLITCH_PLATFORM_TARGET !== "local") {
    throw new Error("The local development fleet requires local Worker configurations.");
  }
  for (const secret of config.secrets?.required ?? []) {
    if (!Object.hasOwn(fixtureSecrets, secret)) {
      throw new Error(`The local development fleet needs an explicit fixture for ${secret}.`);
    }
  }
  const signingKey = process.env.ACCESS_TOKEN_SECRET;
  if (!signingKey) throw new Error("The full local fleet requires its generated Auth signing key.");
  // The plugin merges returned arrays by concatenation. Replace bindings on
  // the input config so the original namespace IDs cannot override these.
  config.kv_namespaces = config.kv_namespaces?.map((namespace) =>
    Object.hasOwn(localNamespaceIds, namespace.binding)
      ? {
          ...namespace,
          id: localNamespaceIds[namespace.binding],
          preview_id: localNamespaceIds[namespace.binding],
        }
      : namespace,
  );
  if (config.name === "splitch-auth-api") {
    config.secrets = {
      ...config.secrets,
      required: [...(config.secrets?.required ?? []), "ACCESS_TOKEN_SECRET"],
    };
  }
  return {
    vars: {
      ...config.vars,
      ...fixtureSecrets,
      SPLITCH_LOCAL_E2E_RUN_ID: runId,
      TINYBIRD_API_URL: analysisSourceOrigin,
      AUTH_JWKS_URI: "http://localhost:8791/.well-known/jwks.json",
      AUTH_API_ORIGIN: "http://localhost:8791",
      CONTROL_PLANE_ORIGIN: "http://127.0.0.1:18790",
      CONTROL_PLANE_API_ORIGIN: "http://127.0.0.1:18790",
      CONTROL_PANEL_ORIGIN: `http://localhost:${gatewayPort}`,
      MCP_ORIGIN: "http://127.0.0.1:8792",
      WORKOS_API_BASE_URL: analysisSourceOrigin,
      EVALUATION_PRIVACY_SALT: "local-app-identity-reset-fixture",
      ...(config.name === "splitch-auth-api"
        ? { ACCESS_TOKEN_SECRET: signingKey, WORKOS_CLIENT_ID: "" }
        : {}),
    },
  };
}

function writeLocalEntryWorker(): string {
  const path = resolve(repoRoot, "test-results/local-dev-worker.ts");
  const routes = Object.fromEntries(
    Object.entries(localDevServices).map(([name, [binding, , port]]) => [
      name,
      [binding, `http://127.0.0.1:${port}`],
    ]),
  );
  mkdirSync(resolve(repoRoot, "test-results"), { recursive: true });
  writeFileSync(
    path,
    `import panel from "../apps/control-panel/src/server";
import type { ConfigStoreDurableObject } from "../apps/control-plane-api/src/config-store-do";

const services = ${JSON.stringify(routes, null, 2)} as const;
type LocalEnv = Parameters<NonNullable<typeof panel.fetch>>[1] &
  Record<(typeof services)[keyof typeof services][0], Fetcher> & {
    LOCAL_CONFIG_STORE_WRITER: DurableObjectNamespace<ConfigStoreDurableObject>;
  };

export default {
  ...panel,
  async fetch(request: Request, env: LocalEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/__dev/seed") {
      const { results } = await env.DB.prepare(
        "SELECT app_id AS appId, environment_id AS environmentId, flag_id AS flagId FROM flag_configs",
      ).all<{ appId: string; environmentId: string; flagId: string }>();
      for (const input of results) {
        const writer = env.LOCAL_CONFIG_STORE_WRITER.getByName(input.appId + ":" + input.environmentId);
        const result = await writer.repairFlagConfigSnapshot(input);
        if (!result.ok) throw new Error("Local Flag Configuration publication failed: " + result.reason);
      }
      return Response.json({ published: results.length });
    }
    if (url.pathname.startsWith("/__dev/services/")) {
      const match = url.pathname.match(/^\\/__dev\\/services\\/([^/]+)(\\/.*)?$/);
      const name = match?.[1];
      const service = name && Object.hasOwn(services, name)
        ? services[name as keyof typeof services]
        : undefined;
      if (!service) return new Response("Unknown local service", { status: 404 });
      const upstream = new URL(service[1]);
      upstream.pathname = match?.[2] ?? "/";
      upstream.search = url.search;
      return env[service[0]].fetch(new Request(upstream, request));
    }
    if (!panel.fetch) throw new Error("The Control Panel Worker must export a fetch handler.");
    return panel.fetch(request, env, ctx);
  },
};
`,
  );
  return path;
}

export function localDevCloudflareConfig(
  runId: string | undefined,
  platformTarget: string,
  isHostedWorkerBuild: boolean,
): PluginConfig | undefined {
  if (process.env.SPLITCH_LOCAL_DEV_FLEET !== "true") return undefined;
  if (!runId || platformTarget !== "local" || isHostedWorkerBuild) {
    throw new Error("The full local fleet requires a local target and a local E2E run ID.");
  }
  const gatewayPort = Number(process.env.SPLITCH_LOCAL_DEV_GATEWAY_PORT ?? "18800");
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) {
    throw new Error("SPLITCH_LOCAL_DEV_GATEWAY_PORT must be an integer from 1024 to 65535.");
  }
  const main = writeLocalEntryWorker();
  return {
    remoteBindings: false,
    inspectorPort: false,
    config: (config) => {
      const localConfig = localWorkerConfig(config, runId, gatewayPort);
      config.services = [
        ...(config.services ?? []),
        ...Object.values(localDevServices).map(([binding, app]) => ({
          binding,
          service: `splitch-${app}`,
        })),
      ];
      config.durable_objects = {
        ...config.durable_objects,
        bindings: [
          ...(config.durable_objects?.bindings ?? []),
          {
            name: "LOCAL_CONFIG_STORE_WRITER",
            class_name: "ConfigStoreDurableObject",
            script_name: "splitch-control-plane-api",
          },
        ],
      };
      return {
        ...localConfig,
        main,
        vars: {
          ...localConfig.vars,
          EVALUATION_API_ORIGIN: `http://127.0.0.1:${gatewayPort}/__dev/services/evaluation`,
        },
      };
    },
    auxiliaryWorkers: Object.values(localDevServices).map(([, app]) => ({
      configPath: resolve(repoRoot, "apps", app, "wrangler.jsonc"),
      devOnly: true,
      config: (config) => localWorkerConfig(config, runId, gatewayPort),
    })),
  };
}
