import type { ApprovalDiff } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { approvalDiffGroups, approvalDiffRows } from "./approval-diff-rows";

function diff(entries: ApprovalDiff["entries"]): ApprovalDiff {
  return { current: {}, proposed: {}, entries };
}

describe("Approval diff rows", () => {
  it("renders the kill switch as serving state, not as a boolean", () => {
    const [row] = approvalDiffRows(
      diff([{ path: "/enabled", operation: "replace", current: true, proposed: false }]),
    );

    expect(row?.group).toBe("Kill switch");
    expect(row?.before).toEqual(["Enabled"]);
    expect(row?.after).toEqual(["Disabled"]);
  });

  /**
   * An empty availability list means the Configuration was never narrowed, so the
   * whole catalog is a candidate. Rendering it as "none" claims the opposite of
   * what the Worker will serve.
   */
  it("does not read an un-narrowed availability list as 'nothing available'", () => {
    const [row] = approvalDiffRows(
      diff([
        {
          path: "/availableVariantNames",
          operation: "replace",
          current: [],
          proposed: ["control"],
        },
      ]),
    );

    expect(row?.before).toEqual(["Not narrowed — every catalog Variant is a candidate"]);
    expect(row?.after).toEqual(["control"]);
  });

  it("names the served Variant and never prints a bucketing salt", () => {
    const rows = approvalDiffRows(
      diff([
        {
          path: "/targetingRules",
          operation: "replace",
          current: [],
          proposed: [
            {
              id: "rule_1",
              priority: 0,
              conditions: [{ attribute: "plan", operator: "eq", value: "pro" }],
              variantId: "var_treatment",
              percentageRollout: { percentage: 25, salt: "s3cr3t-salt" },
            },
          ],
        },
        {
          path: "/rollout",
          operation: "replace",
          current: null,
          proposed: { percentage: 10, salt: "s3cr3t-salt" },
        },
      ]),
      { var_treatment: "treatment" },
    );

    const rendered = rows.flatMap((row) => [...row.before, ...row.after]).join(" ");
    expect(rendered).toContain("serves treatment");
    expect(rendered).toContain("10% of traffic");
    expect(rendered).not.toContain("s3cr3t-salt");
  });

  /**
   * A change with no field mapping still has to reach the operator. Dropping it
   * would mean they approved something the gate never showed them.
   */
  it("keeps an unmapped path as its own row rather than dropping it", () => {
    const rows = approvalDiffRows(
      diff([{ path: "/somethingNew", operation: "add", proposed: "value" }]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.group).toBe("Other");
    expect(rows[0]?.field).toBe("/somethingNew");
    expect(rows[0]?.hasBefore).toBe(false);
  });

  it("names the Configuration version instead of showing a bare JSON Pointer", () => {
    const [row] = approvalDiffRows(
      diff([{ path: "/version", operation: "replace", current: 1, proposed: 2 }]),
    );

    expect(row?.group).toBe("Other");
    expect(row?.field).toBe("Configuration version");
  });

  it("orders groups so the incident-relevant change is read first", () => {
    const rows = approvalDiffRows(
      diff([
        { path: "/rollout", operation: "replace", current: null, proposed: { percentage: 5 } },
        { path: "/enabled", operation: "replace", current: false, proposed: true },
      ]),
    );

    expect(approvalDiffGroups(rows)).toEqual(["Kill switch", "Baseline rollout"]);
  });
});
