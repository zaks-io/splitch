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
    expect(mcpConfig).toContain('"CONTROL_PLANE_API_ORIGIN": "http://localhost:8787"');
    expect(authConfig).toContain('"AUTH_API_ORIGIN": "http://localhost:8791"');
    expect(authConfig).toContain('"CONTROL_PLANE_ORIGIN": "http://localhost:8787"');
    expect(authConfig).toContain('"MCP_ORIGIN": "http://localhost:8792"');
    expect(controlPlaneConfig).toContain('"CONTROL_PLANE_ORIGIN": "http://localhost:8787"');
    expect(mcpConfig.match(/"entrypoint": "McpEntrypoint"/g)).toHaveLength(6);
    for (const config of [controlPlaneConfig, evaluationConfig, analysisConfig]) {
      expect(config.match(/"name": "MCP_DELEGATION_REPLAY"/g)).toHaveLength(3);
      expect(config.match(/"tag": "v\d+_mcp_delegation_replay"/g)).toHaveLength(3);
    }
  });
});
