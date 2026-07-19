import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it, vi } from "vitest";
import { createControlPanelFlagsClient } from "./control-plane-apps";
import { booleanFlagInput } from "./create-flag-model";

const TOKEN_HASH = "b".repeat(64);
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel Flags transport", () => {
  it("sends the guided boolean catalog through an authenticated scoped delegation", async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdFlag());
    });
    const flags = createControlPanelFlagsClient(
      { fetch: fetcher } as unknown as Fetcher,
      { actorId: "user_checkout", sessionExpiresAt: 1_800_003_600 },
      "env_dev",
      DELEGATION_SECRET,
      { nowSeconds: () => 1_800_000_000, nonce: () => "nonce_1234567890abcdef" },
    );

    const result = await flags.create(booleanFlagInput("app_checkout", "new-checkout"));
    const request = capturedRequest;

    expect(result).toMatchObject({ ok: true, data: { key: "new-checkout" } });
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(request?.headers.get("x-splitch-panel-environment")).toBe("env_dev");
    expect(request?.headers.get("authorization")).toBeNull();
    const operation = {
      id: "flags_create",
      appId: "app_checkout",
      environmentId: "env_dev",
    } as const;
    const delegation = await verifyControlPanelDelegation(
      request?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
      request?.clone() as Request,
      operation,
      DELEGATION_SECRET,
      1_800_000_000,
    );
    expect(JSON.stringify(delegation)).not.toContain(TOKEN_HASH);
    expect(delegation).toMatchObject({
      operation: { id: "flags_create", appId: "app_checkout", environmentId: "env_dev" },
      actorId: "user_checkout",
      expiresAt: 1_800_000_030,
      nonce: "nonce_1234567890abcdef",
    });
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
