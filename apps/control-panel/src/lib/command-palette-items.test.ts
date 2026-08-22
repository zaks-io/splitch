import { describe, expect, it } from "vitest";
import type { ScopeNavigation } from "./loader-context";
import {
  paletteActionItems,
  paletteJumpItems,
  paletteScope,
  type ResolvedPaletteScope,
} from "./command-palette-items";
import type { PaletteIndex } from "./palette-index";

const org = { orgId: "org_acme", orgSlug: "acme-labs" };
const index: PaletteIndex = {
  flags: [{ key: "new-checkout" }],
  flagsTruncated: false,
  experiments: [{ id: "experiment_checkout", name: "New Checkout" }],
};

describe("command palette items", () => {
  it("lists Apps and Organization actions on Home", () => {
    const scope = paletteScope(navigation(), org);

    expect(itemIds(scope, index)).toEqual([
      "app:checkout-api",
      "app:billing-api",
      "org:members",
      "org:billing",
    ]);
  });

  it("uses the first non-guarded Environment for App-home reads and actions", () => {
    const scope = paletteScope(navigation(), org, {
      appId: "app_checkout",
      appSlug: "checkout-api",
    });

    expect(scope.target?.environmentId).toBe("env_dev");
    expect(paletteJumpItems(scope, index)).toContainEqual(
      expect.objectContaining({
        id: "flag:new-checkout",
        href: "/acme-labs/checkout-api/dev/flags/new-checkout",
      }),
    );
    expect(paletteActionItems(scope).map((item) => item.id)).toEqual([
      "action:new-flag",
      "section:flags",
      "section:experiments",
      "section:overview",
      "section:segments",
      "section:metrics",
      "section:settings",
      "org:members",
      "org:billing",
    ]);
  });

  it("uses the active Environment even when it is guarded", () => {
    const scope = paletteScope(navigation(), org, {
      appId: "app_checkout",
      appSlug: "checkout-api",
      env: "prod",
    });

    expect(scope.target?.environmentId).toBe("env_prod");
    expect(paletteJumpItems(scope, index)).toContainEqual(
      expect.objectContaining({
        id: "experiment:experiment_checkout",
        href: "/acme-labs/checkout-api/prod/experiments/experiment_checkout",
      }),
    );
  });

  it("omits New Flag and section actions for an App with no Environments", () => {
    const scope = paletteScope(navigation(), org, {
      appId: "app_billing",
      appSlug: "billing-api",
    });

    expect(scope.target).toBeNull();
    expect(paletteActionItems(scope).map((item) => item.id)).toEqual([
      "org:members",
      "org:billing",
    ]);
  });

  it("encodes a Flag key in its detail href", () => {
    const scope = paletteScope(navigation(), org, {
      appId: "app_checkout",
      appSlug: "checkout-api",
      env: "dev",
    });

    expect(
      paletteJumpItems(scope, { ...index, flags: [{ key: "checkout/new" }] }).find(
        (item) => item.id === "flag:checkout/new",
      )?.href,
    ).toBe("/acme-labs/checkout-api/dev/flags/checkout%2Fnew");
  });
});

function itemIds(scope: ResolvedPaletteScope, paletteIndex: PaletteIndex): string[] {
  return [...paletteJumpItems(scope, paletteIndex), ...paletteActionItems(scope)].map(
    (item) => item.id,
  );
}

function navigation(): ScopeNavigation {
  return {
    orgs: [
      {
        ...org,
        apps: [
          {
            appId: "app_checkout",
            appSlug: "checkout-api",
            environments: [
              { environmentId: "env_prod", env: "prod", name: "Production", guarded: true },
              { environmentId: "env_dev", env: "dev", name: "Development", guarded: false },
            ],
          },
          { appId: "app_billing", appSlug: "billing-api", environments: [] },
        ],
      },
    ],
  };
}
