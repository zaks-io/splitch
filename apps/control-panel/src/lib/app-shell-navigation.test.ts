import { describe, expect, it } from "vitest";
import { environmentSwitchHref, scopedHref } from "./app-shell-navigation";

const scope = { appSlug: "checkout-api", env: "dev", orgSlug: "acme-labs" };

describe("App shell navigation", () => {
  it("builds explicit App and Environment destinations", () => {
    expect(scopedHref(scope)).toBe("/acme-labs/checkout-api/dev");
    expect(scopedHref({ ...scope, appSlug: "billing" })).toBe("/acme-labs/billing/dev");
  });

  it("preserves the section, query, and hash while switching Environment", () => {
    expect(
      environmentSwitchHref(
        "/acme-labs/checkout-api/dev/flags/flag_1?tab=rules#rollout",
        scope,
        "prod",
      ),
    ).toBe("/acme-labs/checkout-api/prod/flags/flag_1?tab=rules#rollout");
  });

  it("fails closed to the next scope root when the current URL contradicts the scope", () => {
    expect(environmentSwitchHref("/wrong/path", scope, "prod")).toBe(
      "/acme-labs/checkout-api/prod",
    );
  });
});
