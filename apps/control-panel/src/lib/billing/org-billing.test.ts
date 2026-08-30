import type { OrganizationUsageResponse } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import {
  canManageBilling,
  formatUsageMonth,
  planLabel,
  toUsageDimensions,
  type UsageNames,
  usageShare,
} from "#lib/billing/org-billing";

type Breakdown = OrganizationUsageResponse["breakdown"];

function breakdown(overrides: Partial<Breakdown> = {}): Breakdown {
  return {
    byApp: [],
    byEnvironment: [],
    byFlag: [],
    bySdkRuntime: [],
    byBatch: [],
    bySource: [],
    byExposure: [],
    ...overrides,
  };
}

const names: UsageNames = {
  apps: new Map([["app_1", "Checkout API"]]),
  environments: new Map([["env_1", "Checkout API · Production"]]),
};

function dimension(id: string, resolved: Breakdown) {
  const found = toUsageDimensions(resolved, names).find((entry) => entry.id === id);
  if (!found) throw new Error(`no ${id} dimension`);
  return found;
}

describe("ADR-0033 reporting dimensions", () => {
  it("names every dimension the ADR mandates, in its order", () => {
    expect(toUsageDimensions(breakdown(), names).map((entry) => entry.id)).toEqual([
      "app",
      "environment",
      "flag",
      "sdk-runtime",
      "batch",
      "source",
      "exposure",
    ]);
  });

  it("labels Apps and Environments by name, never by id", () => {
    const app = dimension("app", breakdown({ byApp: [{ appId: "app_1", evaluations: 12 }] }));
    const environment = dimension(
      "environment",
      breakdown({ byEnvironment: [{ environmentId: "env_1", evaluations: 12 }] }),
    );

    expect(app.rows).toEqual([{ key: "app_1", label: "Checkout API", evaluations: 12 }]);
    expect(environment.rows[0]?.label).toBe("Checkout API · Production");
  });

  it("keeps consumption billed to a deleted resource, summed into one stated row", () => {
    const app = dimension(
      "app",
      breakdown({
        byApp: [
          { appId: "app_1", evaluations: 10 },
          { appId: "app_gone", evaluations: 4 },
          { appId: "app_also_gone", evaluations: 6 },
        ],
      }),
    );

    // Dropping the unresolved rows would make the dimension disagree with the
    // month total by 10 Evaluations.
    expect(app.rows.map((row) => row.evaluations).reduce((sum, count) => sum + count)).toBe(20);
    expect(app.rows.at(-1)).toEqual({
      key: "__unresolved__",
      label: "Apps no longer in this Organization",
      evaluations: 10,
    });
  });

  it("ranks rows worst-first and states how many it left out", () => {
    const flags = Array.from({ length: 12 }, (_, index) => ({
      flagKey: `flag-${index}`,
      evaluations: index,
    }));
    const flag = dimension("flag", breakdown({ byFlag: flags }));

    expect(flag.rows).toHaveLength(10);
    expect(flag.rows[0]).toEqual({ key: "flag-11", label: "flag-11", evaluations: 11 });
    expect(flag.totalRows).toBe(12);
  });

  it("renders an unconsumed side of a closed dimension as an explicit zero", () => {
    const source = dimension(
      "source",
      breakdown({ bySource: [{ source: "remote", evaluations: 9 }] }),
    );

    // The group-by returns no row for a mode nobody used; that is a known zero,
    // not an unknown, so it is shown rather than omitted.
    expect(source.rows).toEqual([
      { key: "remote", label: "Remote", evaluations: 9 },
      { key: "cached", label: "Cached", evaluations: 0 },
    ]);
  });

  it("covers both sides of every closed dimension", () => {
    const dimensions = toUsageDimensions(breakdown(), names);
    expect(dimensions.find((entry) => entry.id === "batch")?.rows.map((row) => row.key)).toEqual([
      "single",
      "batch",
    ]);
    expect(dimensions.find((entry) => entry.id === "exposure")?.rows.map((row) => row.key)).toEqual(
      ["bearing", "not_bearing"],
    );
  });

  it("does not render a blank label for a key that identified nothing", () => {
    const runtime = dimension(
      "sdk-runtime",
      breakdown({ bySdkRuntime: [{ sdkRuntime: "", evaluations: 3 }] }),
    );

    expect(runtime.rows).toEqual([
      {
        key: "__unresolved__",
        label: "Runtimes that did not identify themselves",
        evaluations: 3,
      },
    ]);
  });
});

describe("usage share", () => {
  it("measures a row against the month total, not against the biggest row", () => {
    expect(usageShare(25, 100)).toBe(0.25);
  });

  it("refuses to compute a share of nothing rather than drawing a full bar", () => {
    expect(() => usageShare(0, 0)).toThrow(/positive month total/);
  });
});

describe("billing role gate and labels", () => {
  it("is owner-only", () => {
    expect(canManageBilling("owner")).toBe(true);
    expect(canManageBilling("admin")).toBe(false);
    expect(canManageBilling("member")).toBe(false);
  });

  it("names an unknown plan loudly instead of showing the raw column", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(() => planLabel("legacy_tier")).toThrow(/unknown Organization plan/);
  });

  it("formats the period in UTC, so the last day of a month keeps its month", () => {
    expect(formatUsageMonth("2026-08")).toBe("August 2026");
    expect(() => formatUsageMonth("2026-8")).toThrow(/unusable usage period/);
  });
});
