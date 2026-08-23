import { describe, expect, it } from "vitest";
import { needsYouEmptyCopy, needsYouItems, needsYouMeasuredClear } from "./home-needs-you";
import type { AppAttention, OrgAppListApp, OrgAppListView } from "./org-app-list";

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

function rollup(states: readonly ["env_dev" | "env_prod", "clear" | "no_data"][]): AppAttention {
  return {
    kind: "ready",
    items: states.map(([environmentId, state]) => ({
      environmentId,
      state,
      srm: false,
      guardrail: false,
    })),
  };
}

describe("needsYouMeasuredClear", () => {
  it("never claims clear over Environments that only have no_data rollups", () => {
    // ADR-0036: a fresh Environment with no traffic was read, not measured.
    const noData = view([
      app(
        "checkout-api",
        rollup([
          ["env_dev", "no_data"],
          ["env_prod", "no_data"],
        ]),
      ),
    ]);

    expect(needsYouMeasuredClear(noData)).toBe(false);
    expect(needsYouEmptyCopy(noData)).toBe(
      "Nothing needs you yet. No Experiment has produced data in any Environment.",
    );
  });

  it("claims clear only over the measured Environments when the rest have no data", () => {
    const mixed = view([
      app(
        "checkout-api",
        rollup([
          ["env_dev", "no_data"],
          ["env_prod", "clear"],
        ]),
      ),
    ]);

    expect(needsYouMeasuredClear(mixed)).toBe(true);
    expect(needsYouEmptyCopy(mixed)).toBe(
      "Nothing needs you. Every Environment with Experiment data is clear.",
    );
  });

  it("claims every Environment only when every Environment measured clear", () => {
    const allClear = view([
      app(
        "checkout-api",
        rollup([
          ["env_dev", "clear"],
          ["env_prod", "clear"],
        ]),
      ),
    ]);

    expect(needsYouMeasuredClear(allClear)).toBe(true);
    expect(needsYouEmptyCopy(allClear)).toBe(
      "Nothing needs you. Experiment health is clear in every Environment.",
    );
  });

  it("stays neutral when there is nothing to measure at all", () => {
    const noApps = view([]);
    expect(needsYouMeasuredClear(noApps)).toBe(false);
    expect(needsYouEmptyCopy(noApps)).toBe("Nothing needs you yet. This Organization has no Apps.");
  });
});

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
