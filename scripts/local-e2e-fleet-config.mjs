export const localBindings = {
  CONTROL_PANEL_DELEGATION_SECRET: "local-control-panel-delegation-secret",
  SENTRY_DSN: "",
  SPLITCH_DEPLOY_GATE_TOKEN: "local-e2e-deploy-gate",
  WORKOS_API_KEY: "local-e2e-workos-api-key",
  WORKOS_CLIENT_ID: "local-e2e-workos-client-id",
};

export function localE2eWorkers(persistPath) {
  return [
    {
      name: "analysis-source",
      origin: "http://127.0.0.1:18788",
      command: "node",
      args: ["scripts/local-e2e-analysis-source.mjs"],
    },
    {
      name: "analysis-api",
      origin: "http://127.0.0.1:8790",
      command: "pnpm",
      args: [
        "exec",
        "wrangler",
        "dev",
        "--config",
        "apps/analysis-api/wrangler.jsonc",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        "8790",
        "--inspector-port",
        "9231",
        "--persist-to",
        persistPath,
        "--var",
        "TINYBIRD_API_URL:http://127.0.0.1:18788",
        "--var",
        "TINYBIRD_READ_TOKEN:local-e2e-tinybird-read-token",
        "--var",
        "TINYBIRD_COPY_TOKEN:local-e2e-tinybird-copy-token",
        "--var",
        "SENTRY_DSN:",
      ],
      checkRunId: false,
      env: {
        TINYBIRD_READ_TOKEN: "local-e2e-tinybird-read-token",
        TINYBIRD_COPY_TOKEN: "local-e2e-tinybird-copy-token",
      },
    },
    {
      name: "control-plane-api",
      origin: "http://127.0.0.1:18790",
      command: "pnpm",
      args: [
        "exec",
        "wrangler",
        "dev",
        "--config",
        "apps/control-plane-api/wrangler.jsonc",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        "18790",
        "--inspector-port",
        "9230",
        "--persist-to",
        persistPath,
        // The token minted by analysis-source is issued by 18788 FOR this origin,
        // and this is the Worker that verifies it: operator-addressed reads land
        // here even when the Analysis Worker executes them (ADR-0046). Without a
        // reachable JWKS the verify step fails at the socket, which the registrar
        // turns into a 500 on a route that should have answered.
        //
        // These are exactly what `ControlPlaneApiEnv` declares and what the
        // hosted wrangler.jsonc sets, so the fleet cannot drift from production
        // by carrying a var this Worker never reads.
        "--var",
        "AUTH_JWKS_URI:http://127.0.0.1:18788/.well-known/jwks.json",
        "--var",
        "CONTROL_PLANE_ORIGIN:http://127.0.0.1:18790",
      ],
    },
    {
      name: "control-panel",
      origin: "http://127.0.0.1:18793",
      command: "pnpm",
      args: [
        "--filter",
        "@splitch/control-panel",
        "exec",
        "vite",
        "dev",
        "--host",
        "127.0.0.1",
        "--port",
        "18793",
      ],
      env: {
        ...localBindings,
        SPLITCH_LOCAL_E2E_PERSIST_PATH: persistPath,
      },
    },
  ];
}
