import { writeFile } from "node:fs/promises";
import { createMcpOperationAdapter, deriveMcpTools } from "@splitch/sdk/control-plane";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { EXIT_OK } from "./exit-codes.js";
import {
  makeQuickstartHarness,
  type QuickstartHarness,
  quickstartOrigins,
  storedHarnessCredential,
} from "./quickstart-local-harness.js";
import { cleanupTempHomes, makeTempHome } from "./test-helpers.js";

describe("Temporary Environment CLI and MCP lifecycle over local handlers", {
  timeout: 60_000,
}, () => {
  let harness: QuickstartHarness;

  beforeEach(async () => {
    harness = await makeQuickstartHarness();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness?.dispose();
    await cleanupTempHomes();
  });

  it("creates, Syncs and deletes through both derived command and MCP inputs", async () => {
    const { credentialPath, dir } = await makeTempHome();
    await writeFile(credentialPath, `${JSON.stringify(storedHarnessCredential(harness))}\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const options = {
      credentialPath,
      cwd: dir,
      env: {},
      fetch: harness.routingFetch,
      platformTarget: "local" as const,
      ...quickstartOrigins,
    };
    async function cli(args: string[]): Promise<Record<string, unknown>> {
      log.mockClear();
      const code = await runCli([...args, "--app", harness.appId, "--json"], options);
      const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(code, `${args.slice(0, 2).join(" ")}: ${payload.code ?? "success"}`).toBe(EXIT_OK);
      return payload;
    }

    await cli([
      "flags",
      "create",
      "--key",
      "temporary-copy",
      "--variants",
      "on,off",
      "--lifecycle-class",
      "permission",
    ]);
    await cli([
      "flag-config",
      "update",
      "temporary-copy",
      "--env",
      "dev",
      "--enabled",
      "true",
      "--rollout",
      "100",
    ]);

    const created = await cli([
      "envs",
      "create",
      "--key",
      "pr-cli",
      "--temporary",
      "--from",
      "dev",
    ]);
    expect(created).toMatchObject({
      key: "pr-cli",
      temporary: { syncedFromEnvironmentId: harness.devEnvironmentId },
      clientKey: { environmentId: created.id },
    });
    expect(await cli(["flag-config", "get", "temporary-copy", "--env", "pr-cli"])).toMatchObject({
      enabled: true,
      rollout: { percentage: 100 },
    });
    const synced = await cli(["envs", "sync", "--env", "pr-cli", "--from", "prod"]);
    expect(synced).toMatchObject({
      syncedFlags: 1,
      temporary: { syncedFromEnvironmentId: harness.prodEnvironmentId },
    });
    expect(await cli(["flag-config", "get", "temporary-copy", "--env", "pr-cli"])).toMatchObject({
      enabled: false,
      rollout: null,
    });
    expect(await cli(["envs", "delete", "--env", "pr-cli"])).toEqual({ deleted: true });

    const tools = new Map(deriveMcpTools().map((tool) => [tool.name, tool]));
    const adapter = createMcpOperationAdapter({
      baseUrl: quickstartOrigins.controlPlaneBaseUrl,
      fetch: harness.routingFetch,
      authorization: `Bearer ${harness.accessToken}`,
    });
    async function mcp(operationId: string, input: Record<string, unknown>) {
      const tool = tools.get(operationId);
      if (!tool) throw new Error(`Missing derived MCP tool ${operationId}`);
      const result = await adapter.callOperationById(
        operationId,
        tool.inputSchema.parse({ appId: harness.appId, ...input }),
      );
      expect(result.ok, operationId).toBe(true);
      if (!result.ok) throw new Error(`MCP ${operationId} failed with ${result.error.code}`);
      return tool.outputSchema.parse(result.data);
    }

    const mcpCreated = await mcp("environments_create", {
      key: "pr-mcp",
      temporary: { fromEnvironmentId: "dev" },
    });
    expect(mcpCreated).toMatchObject({
      key: "pr-mcp",
      temporary: { syncedFromEnvironmentId: harness.devEnvironmentId },
    });
    expect(
      await mcp("environments_sync", {
        environmentId: mcpCreated.id,
        by: "id",
        fromEnvironmentId: "prod",
      }),
    ).toMatchObject({
      syncedFlags: 1,
      temporary: { syncedFromEnvironmentId: harness.prodEnvironmentId },
    });
    expect(await mcp("environments_delete", { environmentId: mcpCreated.id, by: "id" })).toEqual({
      deleted: true,
    });
    const listed = await cli(["envs", "list"]);
    expect(listed).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: harness.devEnvironmentId, temporary: null }),
        expect.objectContaining({ id: harness.prodEnvironmentId, temporary: null }),
      ]),
    });
    expect(JSON.stringify(listed)).not.toContain("pr-cli");
    expect(JSON.stringify(listed)).not.toContain("pr-mcp");
  });
});
