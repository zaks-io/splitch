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

    expect(mcpConfig).toContain('"AUTH_API_ORIGIN": "http://localhost:8791"');
    expect(mcpConfig).toContain('"CONTROL_PLANE_API_ORIGIN": "http://localhost:8787"');
    expect(authConfig).toContain('"AUTH_API_ORIGIN": "http://localhost:8791"');
    expect(authConfig).toContain('"CONTROL_PLANE_ORIGIN": "http://localhost:8787"');
    expect(controlPlaneConfig).toContain('"CONTROL_PLANE_ORIGIN": "http://localhost:8787"');
  });
});
