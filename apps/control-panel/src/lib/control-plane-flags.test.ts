import { describe, expect, it, vi } from "vitest";
import { createControlPanelFlagsClient } from "./control-plane-apps";
import { booleanFlagInput } from "./create-flag-model";

const TOKEN_HASH = "b".repeat(64);

describe("Control Panel Flags transport", () => {
  it("sends the guided boolean catalog through the session-authorized Worker binding", async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdFlag());
    });
    const flags = createControlPanelFlagsClient(
      { fetch: fetcher } as unknown as Fetcher,
      TOKEN_HASH,
      "env_dev",
    );

    const result = await flags.create(booleanFlagInput("app_checkout", "new-checkout"));
    const request = capturedRequest;

    expect(result).toMatchObject({ ok: true, data: { key: "new-checkout" } });
    expect(request?.headers.get("x-splitch-panel-session")).toBe(TOKEN_HASH);
    expect(request?.headers.get("x-splitch-panel-environment")).toBe("env_dev");
    expect(request?.headers.get("authorization")).toBeNull();
    await expect(request?.clone().json()).resolves.toMatchObject({
      appId: "app_checkout",
      key: "new-checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });
  });
});

function createdFlag() {
  return {
    id: "flag_checkout",
    appId: "app_checkout",
    key: "new-checkout",
    name: "New Checkout",
    schema: { type: "boolean" },
    variants: [
      { id: "var_disabled", name: "disabled", value: false },
      { id: "var_enabled", name: "enabled", value: true },
    ],
    defaultVariantId: "var_disabled",
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
  };
}
