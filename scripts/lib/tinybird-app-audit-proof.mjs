import { output, run } from "./tinybird-process.mjs";

export async function proveAppAuditBoundary(projectDir) {
  // The CLI builds in a project-specific workspace, separate from the container's initial workspace.
  const info = JSON.parse(
    await output("tb", ["--no-version-warning", "--output", "json", "info"], projectDir),
  );
  const workspaceToken = info.local?.token;
  if (typeof workspaceToken !== "string" || !workspaceToken) {
    throw new Error("Tinybird Local build workspace token is unavailable");
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
        SPLITCH_TEST_TINYBIRD_API_URL: "http://127.0.0.1:7181",
        SPLITCH_TEST_TINYBIRD_TOKEN: workspaceToken,
      },
    },
  );
}
