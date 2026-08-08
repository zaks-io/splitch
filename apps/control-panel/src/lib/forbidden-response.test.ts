import { describe, expect, it } from "vitest";
import { requireForbiddenResponse } from "../../../../e2e/control-panel/forbidden-response";

describe("requireForbiddenResponse", () => {
  it.each([
    {
      name: "forced member add succeeds",
      body: {
        id: "user_other_org",
        email: "other@example.com",
        organizationId: "org_target",
        role: "owner",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    },
    {
      name: "forced owner grant succeeds",
      body: {
        id: "user_existing",
        email: "existing@example.com",
        organizationId: "org_target",
        role: "owner",
        createdAt: "2026-08-07T00:00:00.000Z",
      },
    },
  ])("rejects a false-green oracle when $name", async ({ body }) => {
    await expect(
      requireForbiddenResponse({
        json: async () => ({ k: ["ok", "data", "status"], v: [true, body, 200] }),
      }),
    ).rejects.toThrow(/expected result status 403, received 200/);
  });

  it("accepts a typed forbidden result inside the HTTP 200 TanStack envelope", async () => {
    await expect(
      requireForbiddenResponse({
        json: async () => ({
          k: ["ok", "error", "status"],
          v: [false, { code: "FORBIDDEN", message: "forbidden", details: {} }, 403],
        }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a different error code at result status 403", async () => {
    await expect(
      requireForbiddenResponse({
        json: async () => ({
          k: ["ok", "error", "status"],
          v: [false, { code: "UNAUTHORIZED", message: "unauthorized", details: {} }, 403],
        }),
      }),
    ).rejects.toThrow(/expected result error code "FORBIDDEN"/);
  });
});
