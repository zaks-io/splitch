import { describe, expect, it } from "vitest";
import { findCommand } from "./command-registry";
import { executeInvocation } from "./execute";
import { parseInvocation } from "./parse-args";
import { FakeCliTransport, oauthTokenMint, storedCredential } from "./test-fixtures";

const SUMMARY = {
  appId: "app_1",
  environmentId: "env_1",
  wake: "scheduled",
  providers: {
    convex: { pendingCount: 2, leasedCount: 1, oldestOutstandingAgeMs: 120_000 },
    cloudflare: { pendingCount: 0, leasedCount: 0, oldestOutstandingAgeMs: null },
  },
};

describe("Environment integration delivery", () => {
  it("derives an Environment-scoped command from the shared operation", () => {
    expect(findCommand(["integration-deliveries", "create"])).toMatchObject({
      operationId: "integration_deliveries_create",
      needsApp: true,
      needsEnvironment: true,
    });
  });
  it.each([false, true])(
    "calls the scoped POST and prints the summary with JSON=%s",
    async (json) => {
      const transport = new FakeCliTransport([
        oauthTokenMint(),
        {
          match: (request) =>
            request.url.endsWith("/apps/app_1/envs/env_1/integrations/deliveries") &&
            request.method === "POST",
          status: 200,
          body: SUMMARY,
        },
      ]);
      const output: string[] = [];
      const result = await executeInvocation(
        parseInvocation([
          "integration-deliveries",
          "create",
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
      expect(output.join("\n")).toContain("scheduled");
      if (json) expect(JSON.parse(output.join(""))).toEqual(SUMMARY);
    },
  );
});
