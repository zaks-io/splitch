import { describe, expect, it } from "vitest";
import { promotionDiff } from "./promotion-diff";
import { promotionView, stagingView } from "./promotion-fixture";
import {
  availabilityOnlySelection,
  landedAvailability,
  promotionDependencies,
  promotionSelect,
  promotionSummary,
  selectedRows,
  variantSelection,
  wholeConfigSelection,
} from "./promotion-selection";

const source = stagingView();
const target = promotionView();
const rows = promotionDiff(source, target).rows;

describe("Promotion selection", () => {
  it("omits an unticked field group rather than sending it as false", () => {
    // `.strict()` on the endpoint takes an explicit value at face value, so
    // `targeting: false` would be a different request from "leave it alone".
    const select = promotionSelect(selectedRows(rows, new Set(["rollout"])));

    expect(select).toEqual({ rollout: true });
    expect(Object.keys(select)).toEqual(["rollout"]);
  });

  it("never drops or invents a row across every possible selection", () => {
    for (let mask = 0; mask < 2 ** rows.length; mask += 1) {
      const chosen = rows.filter((_, index) => (mask & (1 << index)) !== 0);
      const select = promotionSelect(selectedRows(rows, new Set(chosen.map((row) => row.id))));

      expect(select.availability ?? []).toEqual(
        chosen.filter((row) => row.kind === "availability").map((row) => row.variantName),
      );
      expect(select.targeting).toBe(chosen.some((row) => row.kind === "targeting") || undefined);
      expect(select.rollout).toBe(chosen.some((row) => row.kind === "rollout") || undefined);
      expect(select.enabled).toBe(chosen.some((row) => row.kind === "enabled") || undefined);
    }
  });

  it("builds each preset out of rows the diff already found", () => {
    expect(wholeConfigSelection(rows)).toEqual(new Set(rows.map((row) => row.id)));
    expect(availabilityOnlySelection(rows)).toEqual(new Set(["availability:beta"]));
    expect(variantSelection(rows, "beta")).toEqual(new Set(["availability:beta"]));
    // A preset can only pre-tick; it can never reach the Worker with something the
    // operator cannot see ticked and untick.
    for (const id of wholeConfigSelection(rows)) {
      expect(rows.some((row) => row.id === id)).toBe(true);
    }
  });
});

describe("Promotion dependency nudge", () => {
  it("offers the availability row a promoted rule needs, and never ticks it itself", () => {
    const nudges = promotionDependencies(rows, new Set(["targeting"]), source, target);

    expect(nudges).toEqual([
      {
        variantName: "beta",
        reason: 'Targeting Rule 1: plan eq "pro" → beta (25%)',
        remedy: "tick",
        rowId: "availability:beta",
      },
    ]);
    // The offer changed nothing: the payload still carries targeting alone.
    expect(promotionSelect(selectedRows(rows, new Set(["targeting"])))).toEqual({
      targeting: true,
    });
  });

  it("goes quiet once the needed availability row is ticked too", () => {
    const nudges = promotionDependencies(
      rows,
      new Set(["targeting", "availability:beta"]),
      source,
      target,
    );

    expect(nudges).toEqual([]);
  });

  it("warns when UNTICKING availability would strand a rule the target already has", () => {
    // The target has beta available and rules that serve it; the source does not.
    // Promoting the availability row alone REMOVES beta and strands the target's
    // own rules. Same walk the Worker does, so the panel cannot disagree with it.
    const stranded = stagingView({ env: "prod" });
    const plain = promotionView({ env: "staging" });
    const strandRows = promotionDiff(plain, stranded).rows;

    const nudges = promotionDependencies(
      strandRows,
      new Set(strandRows.filter((row) => row.kind === "availability").map((row) => row.id)),
      plain,
      stranded,
    );

    expect(nudges.map((nudge) => nudge.variantName)).toEqual(["beta"]);
    expect(nudges[0]?.remedy).toBe("untick");
  });

  it("says no row can fix it when the Variant is unavailable in both Environments", () => {
    const bothMissing = stagingView({
      catalog: promotionView().catalog,
      availableVariantCount: 1,
    });
    const bothRows = promotionDiff(bothMissing, promotionView()).rows;

    const nudges = promotionDependencies(bothRows, new Set(["targeting"]), bothMissing, target);

    expect(nudges[0]).toMatchObject({ variantName: "beta", remedy: "none", rowId: null });
  });

  it("computes the landed availability the way the Worker copies it, deletions included", () => {
    const ticked = selectedRows(rows, new Set(["availability:beta"]));

    expect(landedAvailability(ticked, source, target)).toEqual(["control", "beta"]);
    expect(landedAvailability(ticked, target, source)).toEqual(["control"]);
  });
});

describe("Promotion summary", () => {
  it("names the ticked field groups by the labels the rows carry", () => {
    expect(promotionSummary(rows, "staging", "prod")).toBe(
      "Promote availability for beta, all Targeting Rules, the baseline rollout and the serving state from staging into prod",
    );
  });
});
