import { describe, expect, it } from "vitest";
import type { AppAttention, OrgAppListApp, OrgAppListView } from "./org-app-list";
import { needsYouItems } from "./home-needs-you";

const environments = [
  { environmentId: "env_dev", env: "dev", name: "Development", guarded: false },
  { environmentId: "env_prod", env: "prod", name: "Production", guarded: true },
] as const;

function app(appSlug: string, attention: AppAttention): OrgAppListApp {
  return {
    appId: `app_${appSlug}`,
    appSlug,
    environments,
    attention,
    flags: { kind: "ready", count: 2, truncated: false },
  };
}

function view(apps: readonly OrgAppListApp[]): OrgAppListView {
  return {
    orgId: "org_1",
    orgSlug: "acme-labs",
    orgRole: "owner",
    isProvisional: false,
    demoExpiresAt: null,
    apps,
    pendingAppResync: null,
    lastVisited: null,
    now: 10_000,
  };
}

describe("needsYouItems", () => {
  it("returns nothing when every Environment is clear", () => {
    expect(
      needsYouItems(
        view([
          app("checkout-api", {
            kind: "ready",
            items: environments.map(({ environmentId }) => ({
              environmentId,
              state: "clear",
              srm: false,
              guardrail: false,
            })),
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it("uses SRM and Guardrail wording from the shared attention label", () => {
    const items = needsYouItems(
      view([
        app("checkout-api", {
          kind: "ready",
          items: [
            {
              environmentId: "env_dev",
              state: "attention",
              srm: true,
              guardrail: true,
            },
            {
              environmentId: "env_prod",
              state: "clear",
              srm: false,
              guardrail: false,
            },
          ],
        }),
      ]),
    );

    expect(items).toEqual([
      expect.objectContaining({
        severity: "attention",
        reason: "Development needs attention: Sample Ratio Mismatch firing and Guardrail breached.",
        href: "/acme-labs/checkout-api/dev",
      }),
    ]);
  });

  it("turns an unavailable App into one unknown item per Environment", () => {
    const items = needsYouItems(
      view([
        app("checkout-api", {
          kind: "unavailable",
          message: "analysis attention data is unavailable",
        }),
      ]),
    );

    expect(items).toHaveLength(2);
    expect(items.map(({ severity }) => severity)).toEqual(["unknown", "unknown"]);
    expect(items.map(({ reason }) => reason)).toEqual([
      "Development health is unknown: analysis attention data is unavailable.",
      "Production health is unknown: analysis attention data is unavailable.",
    ]);
  });

  it("orders attention before unknown while preserving App and Environment order", () => {
    const first = app("first", {
      kind: "ready",
      items: [
        { environmentId: "env_dev", state: "clear", srm: false, guardrail: false },
        { environmentId: "env_prod", state: "attention", srm: true, guardrail: false },
      ],
    });
    const second = app("second", {
      kind: "ready",
      items: [{ environmentId: "env_dev", state: "attention", srm: false, guardrail: true }],
    });

    expect(
      needsYouItems(view([first, second])).map(({ appSlug, env, severity }) => ({
        appSlug,
        env,
        severity,
      })),
    ).toEqual([
      { appSlug: "first", env: "prod", severity: "attention" },
      { appSlug: "second", env: "dev", severity: "attention" },
      { appSlug: "second", env: "prod", severity: "unknown" },
    ]);
  });
});
