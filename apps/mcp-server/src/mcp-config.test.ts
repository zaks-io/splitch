import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("MCP OAuth origin configuration", () => {
  it("keeps local issuer, audience, and upstream origins canonical", async () => {
    const mcpConfig = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    const authConfig = await readFile(
      new URL("../../auth-api/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const controlPlaneConfig = await readFile(
      new URL("../../control-plane-api/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const evaluationConfig = await readFile(
      new URL("../../evaluation-api/wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const analysisConfig = await readFile(
      new URL("../../analysis-api/wrangler.jsonc", import.meta.url),
      "utf8",
    );

    expect(mcpConfig).toContain('"AUTH_API_ORIGIN": "http://localhost:8791"');
    expect(
      mcpConfig.match(
        /"MCP_OAUTH_AUTHORIZATION_SERVER": "https:\/\/soulful-path-50\.authkit\.app"/g,
      ),
    ).toHaveLength(2);
    expect(mcpConfig).toContain('"CONTROL_PLANE_API_ORIGIN": "http://localhost:8787"');
    expect(authConfig).toContain('"AUTH_API_ORIGIN": "http://localhost:8791"');
    expect(authConfig).toContain('"CONTROL_PLANE_ORIGIN": "http://localhost:8787"');
    expect(authConfig).toContain('"MCP_ORIGIN": "http://localhost:8792"');
    expect(controlPlaneConfig).toContain('"CONTROL_PLANE_ORIGIN": "http://localhost:8787"');
    expect(mcpConfig.match(/"entrypoint": "McpEntrypoint"/g)).toHaveLength(3);
    expect(mcpConfig.match(/"binding": "CONTROL_PLANE_API"/g)).toHaveLength(3);
    expect(mcpConfig.match(/"binding": "SESSION_STORE"/g)).toHaveLength(3);
    for (const id of [
      "00000000000000000000000000000000",
      "673d17e768eb45f5bfc5275fbd0e9320",
      "bdfa1197123d4eef945c5a703d63a572",
    ]) {
      expect(authConfig).toContain(`"id": "${id}"`);
      expect(mcpConfig).toContain(`"id": "${id}"`);
    }
    for (const config of [controlPlaneConfig, evaluationConfig, analysisConfig]) {
      expect(config.match(/"name": "MCP_DELEGATION_REPLAY"/g)).toHaveLength(3);
    }
    expect(controlPlaneConfig).toContain(
      '"McpDelegationReplayDurableObject": { "type": "durable-object", "storage": "sqlite" }',
    );
    for (const config of [evaluationConfig, analysisConfig]) {
      expect(config.match(/"tag": "v\d+_mcp_delegation_replay"/g)).toHaveLength(3);
    }
  });
});
