import {
  CONTROL_PANEL_DELEGATION_HEADER,
  verifyControlPanelDelegation,
} from "@splitch/control-plane-sdk/control-panel-identity";
import type {
  PerformanceSpanAttribute,
  PerformanceSpanDescriptor,
  PerformanceSpanRecorder,
} from "@splitch/observability/performance-spans";
import { describe, expect, it, vi } from "vitest";
import { createControlPanelAppsClient, panelDelegationFetch } from "#lib/shared/control-plane-apps";

const ACTOR = { actorId: "user_acme", sessionExpiresAt: 1_800_003_600 };
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";
const TOKEN_HASH = "a".repeat(64);

describe("Control Panel Apps transport", () => {
  it("records the binding operation and status without resource identifiers", async () => {
    const recorded: Array<{
      descriptor: PerformanceSpanDescriptor;
      attributes: Record<string, PerformanceSpanAttribute>;
    }> = [];
    const spanRecorder: PerformanceSpanRecorder = {
      async record(descriptor, run) {
        const attributes = { ...descriptor.attributes };
        recorded.push({ descriptor, attributes });
        return run({
          setAttribute(key, value) {
            attributes[key] = value;
          },
          setAttributes(values) {
            Object.assign(attributes, values);
          },
        });
      },
    };
    const apps = createControlPanelAppsClient(
      { fetch: async () => Response.json(createdApp()) } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
      {
        nowSeconds: () => 1_800_000_000,
        nonce: () => "nonce_span_123456789",
        spanRecorder,
      },
    );

    await apps.create({ orgId: "org_secret", name: "Checkout", key: "checkout" });

    expect(recorded).toEqual([
      {
        descriptor: expect.objectContaining({
          name: "Control Plane apps_create",
          op: "rpc.client",
        }),
        attributes: {
          "rpc.system": "cloudflare.service_binding",
          "rpc.method": "apps_create",
          "rpc.response.status_code": 200,
        },
      },
    ]);
    expect(JSON.stringify(recorded)).not.toContain("org_secret");
  });

  it("carries only an authenticated operation-scoped delegation over the Worker binding", async () => {
    let capturedRequest: Request | undefined;
    const fetcher = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return Response.json(createdApp());
    });
    const apps = createControlPanelAppsClient(
      { fetch: fetcher } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
      {
        nowSeconds: () => 1_800_000_000,
        nonce: () => "nonce_1234567890abcdef",
      },
    );

    const result = await apps.create({
      orgId: "org_acme",
      name: "Checkout",
      key: "checkout",
    });

    const request = capturedRequest;
    expect(request).toBeInstanceOf(Request);
    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("x-splitch-panel-session")).toBeNull();
    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cookie")).toBeNull();
    expect(await request?.clone().text()).not.toContain(TOKEN_HASH);
    const operation = { id: "apps_create", orgId: "org_acme" } as const;
    await expect(
      verifyControlPanelDelegation(
        request?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        request?.clone() as Request,
        operation,
        DELEGATION_SECRET,
        1_800_000_000,
      ),
    ).resolves.toMatchObject({
      version: 1,
      operation,
      actorId: ACTOR.actorId,
      expiresAt: 1_800_000_030,
      nonce: "nonce_1234567890abcdef",
    });
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(JSON.stringify(result)).not.toContain(TOKEN_HASH);
  });

  it("reads attention through an App-scoped binding delegation without bearer material", async () => {
    let capturedRequest: Request | undefined;
    const apps = createControlPanelAppsClient(
      {
        fetch: async (request: Request) => {
          capturedRequest = request;
          return Response.json({
            appId: "app_checkout",
            items: [
              {
                environmentId: "env_prod",
                state: "attention",
                srm: true,
                guardrail: false,
              },
            ],
          });
        },
      } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
      {
        nowSeconds: () => 1_800_000_000,
        nonce: () => "nonce_attention_123456",
      },
    );

    const result = await apps.getAttentionRollup({ appId: "app_checkout" });
    const request = capturedRequest;

    expect(request?.headers.get("authorization")).toBeNull();
    expect(request?.headers.get("cookie")).toBeNull();
    const operation = { id: "app_attention_rollup_get", appId: "app_checkout" } as const;
    await expect(
      verifyControlPanelDelegation(
        request?.headers.get(CONTROL_PANEL_DELEGATION_HEADER) ?? null,
        request?.clone() as Request,
        operation,
        DELEGATION_SECRET,
        1_800_000_000,
      ),
    ).resolves.toMatchObject({ operation, actorId: ACTOR.actorId });
    expect(result).toMatchObject({
      ok: true,
      data: { appId: "app_checkout", items: [{ environmentId: "env_prod", srm: true }] },
    });
  });
});

// Both refusals live in the transport, before dispatch, so no caller credential
// ever reaches the Control Plane binding.
describe("Control Panel binding credential refusal", () => {
  // The SDK exposes a per-call `authorization` option and this transport copies
  // every inbound header onto the binding request. The entrypoint refuses bearer
  // material, but only after it has crossed the binding, so the refusal has to
  // happen here: the fetcher must never see the credential at all.
  it("refuses caller-supplied bearer material before it crosses the binding", async () => {
    const fetcher = vi.fn(async () => Response.json(createdApp()));
    const apps = createControlPanelAppsClient(
      { fetch: fetcher } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
    );

    await expect(
      apps.getAttentionRollup(
        { appId: "app_checkout" },
        { authorization: "Bearer sk_live_stolen_token" },
      ),
    ).rejects.toThrow("must not carry authorization material");
    expect(fetcher).not.toHaveBeenCalled();
  });

  // Cookies are the panel session credential, so a Request built from an inbound
  // browser request carries one; forwarding it would hand the Control Plane a
  // second, unsigned way to name the caller. The SDK has no per-call cookie
  // option, so this exercises the transport directly.
  it("refuses caller-supplied cookie material before it crosses the binding", async () => {
    const fetcher = vi.fn(async () => Response.json(createdApp()));
    const dispatch = panelDelegationFetch(
      { fetch: fetcher } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
    );

    await expect(
      dispatch("https://control-plane.internal/apps/app_checkout/attention-rollup", {
        headers: { cookie: "splitch_panel_session=stolen" },
      }),
    ).rejects.toThrow("must not carry cookie material");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Control Panel Apps transport failures", () => {
  it("preserves typed Worker refusals for the server function caller", async () => {
    const apps = createControlPanelAppsClient(
      {
        fetch: async () =>
          Response.json(
            {
              code: "FORBIDDEN",
              message: "Organization role does not permit this action",
              details: {},
            },
            { status: 403 },
          ),
      } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
    );

    await expect(
      apps.create({
        orgId: "org_acme",
        name: "Checkout",
        key: "checkout",
      }),
    ).resolves.toEqual({
      ok: false,
      status: 403,
      error: {
        code: "FORBIDDEN",
        message: "Organization role does not permit this action",
        details: {},
      },
    });
  });

  it("rejects an expired panel session before dispatch", async () => {
    const apps = createControlPanelAppsClient(
      { fetch: vi.fn() } as unknown as Fetcher,
      { actorId: "user_acme", sessionExpiresAt: 99 },
      DELEGATION_SECRET,
      { nowSeconds: () => 100 },
    );
    await expect(
      apps.create({
        orgId: "org_acme",
        name: "Checkout",
        key: "checkout",
      }),
    ).rejects.toThrow("control-panel delegation is invalid");
  });
});

function createdApp() {
  const now = "2026-07-18T00:00:00.000Z";
  const policy = {
    variantAvailability: "allow" as const,
    targetingRolloutValue: "allow" as const,
    enabledState: "allow" as const,
    startExperimentRun: "allow" as const,
  };
  return {
    app: {
      id: "app_checkout",
      organizationId: "org_acme",
      name: "Checkout",
      key: "checkout",
      createdAt: now,
      updatedAt: now,
    },
    environments: [
      {
        id: "env_dev",
        appId: "app_checkout",
        key: "dev",
        name: "Dev",
        policy,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "env_prod",
        appId: "app_checkout",
        key: "prod",
        name: "Prod",
        policy,
        createdAt: now,
        updatedAt: now,
      },
    ],
    clientKeys: [
      {
        keyId: "ck_dev",
        appId: "app_checkout",
        environmentId: "env_dev",
        keyMaterial: "pk_dev",
        isOriginOpen: true,
        createdAt: now,
      },
      {
        keyId: "ck_prod",
        appId: "app_checkout",
        environmentId: "env_prod",
        keyMaterial: "pk_prod",
        isOriginOpen: true,
        createdAt: now,
      },
    ],
  };
}
