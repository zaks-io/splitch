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
        status: () => 200,
        json: async () => body,
      }),
    ).rejects.toThrow(/expected HTTP 403, received 200/);
  });

  it("accepts only a typed forbidden response", async () => {
    await expect(
      requireForbiddenResponse({
        status: () => 403,
        json: async () => ({ code: "FORBIDDEN", message: "forbidden" }),
      }),
    ).resolves.toBeUndefined();
  });
});
