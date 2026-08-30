import { describe, expect, it } from "vitest";
import {
  promotionPair,
  promotionSources,
  resolvePromotionSource,
} from "#lib/promotions/promotion-source";

const navigation = {
  orgs: [
    {
      apps: [
        {
          appId: "app_1",
          environments: [
            { environmentId: "env_dev", env: "dev" },
            { environmentId: "env_staging", env: "staging" },
            { environmentId: "env_prod", env: "prod" },
          ],
        },
        { appId: "app_other", environments: [{ environmentId: "env_x", env: "dev" }] },
      ],
    },
  ],
};

describe("Promotion sources", () => {
  it("offers every Environment in this App except the one being changed", () => {
    expect(promotionSources(navigation, "app_1", "prod")).toEqual([
      { environmentId: "env_dev", env: "dev" },
      { environmentId: "env_staging", env: "staging" },
    ]);
  });

  it("never crosses into another App's Environments", () => {
    expect(promotionSources(navigation, "app_other", "dev")).toEqual([]);
  });

  it("refuses an unresolvable source instead of quietly promoting from another one", () => {
    // A silent fallback would diff one pair of Environments and promote another
    // (ADR-0036), which is the one failure this screen cannot survive.
    const sources = promotionSources(navigation, "app_1", "prod");

    expect(resolvePromotionSource(sources, "nope")).toBeUndefined();
    expect(resolvePromotionSource(sources, "prod")).toBeUndefined();
    expect(resolvePromotionSource(sources, "staging")).toEqual({
      environmentId: "env_staging",
      env: "staging",
    });
    expect(resolvePromotionSource(sources, undefined)).toEqual({
      environmentId: "env_dev",
      env: "dev",
    });
  });
});

describe("Promotion pair", () => {
  const environments = navigation.orgs[0]?.apps[0]?.environments ?? [];

  it("compares the first Environment with the last", () => {
    expect(promotionPair(environments)).toEqual({
      source: { environmentId: "env_dev", env: "dev" },
      target: { environmentId: "env_prod", env: "prod" },
    });
  });

  it("has no pair for one Environment", () => {
    expect(promotionPair(environments.slice(0, 1))).toBeNull();
  });
});
