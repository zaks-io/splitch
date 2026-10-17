import { output, run } from "./tinybird-process.mjs";

export async function proveAppAuditBoundary(projectDir) {
  // Unlike `info`, endpoint discovery uses the same inferred local workspace as `build` in CI.
  const endpoints = JSON.parse(
    await output(
      "tb",
      [
        "--no-version-warning",
        "--output",
        "json",
        "endpoint",
        "ls",
        "--match",
        "^app_audit_events$",
      ],
      projectDir,
    ),
  );
  const endpoint = endpoints.pipes?.find((pipe) => pipe.name === "app_audit_events");
  if (typeof endpoint?.url !== "string" || !URL.canParse(endpoint.url)) {
    throw new Error("Tinybird Local App audit endpoint is unavailable");
  }
  const url = new URL(endpoint.url);
  if (!["http://localhost:7181", "http://127.0.0.1:7181"].includes(url.origin)) {
    throw new Error("Tinybird Local App audit endpoint must use the local service");
  }
  const readToken = url.searchParams.get("token");
  if (!readToken) throw new Error("Tinybird Local App audit endpoint token is unavailable");
  const workspace = await localJson(url.origin, "/v1/workspace", readToken);
  if (typeof workspace.id !== "string" || !workspace.id) {
    throw new Error("Tinybird Local App audit workspace identity is unavailable");
  }
  const info = JSON.parse(
    await output("tb", ["--no-version-warning", "--output", "json", "info"], projectDir),
  );
  const userToken = info.local?.user_token;
  if (typeof userToken !== "string" || !userToken) {
    throw new Error("Tinybird Local App audit user token is unavailable");
  }
  // The endpoint token is read-only; the integration proof must also append in this workspace.
  const workspaces = await localJson(url.origin, "/v1/user/workspaces", userToken);
  const workspaceToken = workspaces.workspaces?.find((item) => item.id === workspace.id)?.token;
  if (typeof workspaceToken !== "string" || !workspaceToken) {
    throw new Error("Tinybird Local App audit build workspace token is unavailable");
  }
  await run(
    "pnpm",
    [
      "--filter",
      "@splitch/control-plane-api",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.audit-integration.ts",
    ],
    process.cwd(),
    {
      env: {
        SPLITCH_TEST_TINYBIRD_API_URL: url.origin,
        SPLITCH_TEST_TINYBIRD_TOKEN: workspaceToken,
      },
    },
  );
}

async function localJson(origin, path, token) {
  const response = await fetch(new URL(path, origin), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(
      `Tinybird Local App audit workspace lookup failed with HTTP ${response.status}`,
    );
  }
  return response.json();
}
