import { describe, expect, it } from "vitest";
import { executeInvocation } from "./execute";
import { parseInvocation } from "./parse-args";
import { FakeCliTransport, oauthTokenMint, storedCredential } from "./test-fixtures";

const MISSING_AT = "2026-10-25T08:00:00.000Z";
const PAGE = {
  items: [
    {
      installationId: "00000000-0000-4000-8000-000000000001",
      appId: "app_1",
      environmentId: "env_1",
      environmentVersion: 7,
      status: "active",
      deploymentMissingAt: MISSING_AT,
      callbackUrl: "https://example.convex.site/configuration",
      lastDeliveredVersion: 6,
      lastDeliveredAt: null,
      pendingCount: 0,
      oldestPendingAgeMs: null,
      terminalCount: 1,
      latestDeliveryError: null,
    },
  ],
  readLimit: 200,
  readTruncated: false,
  cursor: null,
};

describe("Convex installation health output", () => {
  it.each([false, true])("preserves the dormant timestamp with JSON=%s", async (json) => {
    const transport = new FakeCliTransport([
      oauthTokenMint(),
      {
        match: (request) =>
          request.url.includes("/integrations/convex/installations") && request.method === "GET",
        status: 200,
        body: PAGE,
      },
    ]);
    const output: string[] = [];
    const result = await executeInvocation(
      parseInvocation([
        "convex-installations",
        "list",
        "--app",
        "app_1",
        "--env",
        "env_1",
        ...(json ? ["--json"] : []),
      ]),
      {
        fetch: transport.fetch,
        credentialStore: {
          load: async () => storedCredential(),
          save: async () => {},
          clear: async () => {},
        },
        io: { log: (line) => output.push(line), error: (line) => output.push(line) },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain(MISSING_AT);
    if (json) expect(JSON.parse(output.join(""))).toEqual(PAGE);
    else expect(output.join("\n")).toContain("DEPLOYMENT MISSING AT");
  });
});
