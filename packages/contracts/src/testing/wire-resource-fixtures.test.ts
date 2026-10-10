import { describe, expect, it } from "vitest";
import { experimentResourceFixture } from "./experiment-resource-fixture";
import { flagResourceFixture } from "./flag-resource-fixture";

describe("wire resource fixtures", () => {
  it("rejects invalid wire overrides before they can become mock responses", () => {
    expect(() => flagResourceFixture({ variants: [] })).toThrow();
    expect(() => experimentResourceFixture({ confidenceLevel: Number.NaN })).toThrow();
  });

  it("replaces nested values explicitly instead of merging the defaults", () => {
    const variants = [{ id: "var_on", name: "on", value: true }];
    expect(flagResourceFixture({ variants, defaultVariantId: "var_on" }).variants).toEqual(
      variants,
    );
    expect(experimentResourceFixture({ dimensions: ["country"] }).dimensions).toEqual(["country"]);
  });

  it("returns independent nested values for each caller", () => {
    const flag = flagResourceFixture();
    const experiment = experimentResourceFixture();
    const variant = flag.variants[0];
    if (!variant) throw new Error("fixture requires a Variant");
    variant.name = "changed";
    experiment.dimensions.push("country");
    expect(flagResourceFixture().variants[0]?.name).toBe("control");
    expect(experimentResourceFixture().dimensions).toEqual([]);
  });
});
