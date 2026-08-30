import { describe, expect, it } from "vitest";
import { requireForbiddenResponse } from "../../../../../e2e/control-panel/forbidden-response";

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
        json: async () => envelope({ ok: true, data: body, status: 200 }),
      }),
    ).rejects.toThrow(/expected a refused TanStack server-function result/);
  });

  it("accepts a typed forbidden result inside the HTTP 200 TanStack envelope", async () => {
    await expect(
      requireForbiddenResponse({
        json: async () =>
          envelope({
            ok: false,
            error: { code: "FORBIDDEN", message: "forbidden", details: {} },
            status: 403,
          }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a different error code at result status 403", async () => {
    await expect(
      requireForbiddenResponse({
        json: async () =>
          envelope({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "unauthorized", details: {} },
            status: 403,
          }),
      }),
    ).rejects.toThrow(/expected result error code "FORBIDDEN"/);
  });
});

type SerializedNode =
  | { t: 0; s: number }
  | { t: 1; s: string }
  | { t: 2; s: 0 | 2 | 3 }
  | { t: 10; i: number; p: { k: string[]; v: SerializedNode[] } };

let nextNodeId = 0;

function envelope(result: Record<string, unknown>): SerializedNode {
  nextNodeId = 0;
  return serializeNode({ result, error: null, context: null });
}

function serializeNode(value: unknown): SerializedNode {
  if (value === null) return { t: 2, s: 0 };
  if (value === true) return { t: 2, s: 2 };
  if (value === false) return { t: 2, s: 3 };
  if (typeof value === "number") return { t: 0, s: value };
  if (typeof value === "string") return { t: 1, s: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    return {
      t: 10,
      i: nextNodeId++,
      p: {
        k: entries.map(([key]) => key),
        v: entries.map(([, entry]) => serializeNode(entry)),
      },
    };
  }
  throw new Error("test envelope contains an unsupported value");
}
