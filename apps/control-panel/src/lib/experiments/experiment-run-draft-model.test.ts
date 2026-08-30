import type { PanelExperimentRun } from "@splitch/control-plane-sdk/panel-experiments";
import { describe, expect, it } from "vitest";
import {
  allocationError,
  buildRunStartInput,
  runDraftErrors,
  startConfirmationCopy,
} from "#lib/experiments/experiment-run-draft-model";

/**
 * A cleared allocation input is the dangerous case, not an obviously broken one.
 * `valueAsNumber` is NaN for a blank number field, and NaN silently defeats
 * BOTH the "totals 100%" guard (`Math.abs(NaN - 100) > 1e-6` is false) and the
 * "drop zero shares" filter (`NaN > 0` is false). Together those turn "operator
 * cleared a field to retype it" into "Variant removed from the next Run", with
 * no error shown and the Start button enabled.
 */
describe("allocationError", () => {
  it("names a blank share instead of letting NaN cancel the total check", () => {
    const message = allocationError({ control: 100, treatment: Number.NaN });

    expect(message).toBe("Every Variant needs a number. Enter 0 to remove one from the next Run.");
  });

  /**
   * Names the blank rather than the total. It does NOT pin the order of the two
   * checks: `Math.abs(NaN - 100) > 1e-6` is false, so the arithmetic branch falls
   * through to the finite check either way and moving the check past it changes
   * nothing observable. What is load-bearing is that the check exists at all —
   * delete it and this fails, because a blank would otherwise report no error.
   */
  it("names the blank share, not the total, when the rest already sum to 100", () => {
    expect(allocationError({ control: 100, treatment: Number.NaN })).toContain("needs a number");
  });

  it("still reports a wrong total when every share is a number", () => {
    expect(allocationError({ control: 100, treatment: 25 })).toBe(
      "Allocation must total 100%. It currently totals 125%.",
    );
  });

  it("accepts a zero share, which is how a Variant is removed on purpose", () => {
    expect(allocationError({ control: 100, treatment: 0 })).toBeNull();
  });

  it("accepts an exact 100% split", () => {
    expect(allocationError({ control: 50, treatment: 50 })).toBeNull();
  });
});

/**
 * Re-Starting after an End is the common case, and it has no Run to abandon.
 * The dialog used to be handed the Run the form pre-filled from, so it warned
 * about abandoning a Run that had already ended — a consequence that had already
 * happened. A confirmation that names a false consequence gets dismissed on
 * reflex, which is exactly what must not happen to the one that is true.
 */
describe("startConfirmationCopy", () => {
  it("warns about abandonment only while a Run is still running", () => {
    const copy = startConfirmationCopy(runningRun(3), 4);

    expect(copy.title).toBe("Run 3 will be abandoned");
    expect(copy.action).toBe("Abandon Run 3 and Start Run 4");
    expect(copy.description).toContain("Run 3 stops accumulating");
  });

  it("never claims an already-ended Run will be abandoned", () => {
    const copy = startConfirmationCopy(undefined, 4);

    expect(copy.title).toBe("A fresh sample will begin");
    expect(copy.action).toBe("Start Run 4");
    expect(`${copy.title} ${copy.description} ${copy.action}`.toLowerCase()).not.toContain(
      "abandon",
    );
  });

  it("states the sample resets either way, because that is true either way", () => {
    expect(startConfirmationCopy(undefined, 4).description).toContain("fresh sample from zero");
    expect(startConfirmationCopy(runningRun(3), 4).description).toContain("fresh sample from zero");
  });
});

function runningRun(runNumber: number): PanelExperimentRun {
  return { runNumber, status: "running" } as PanelExperimentRun;
}

describe("buildRunStartInput", () => {
  const base = {
    activationMetricId: "",
    appId: "app_1",
    environmentId: "env_1",
    experimentId: "exp_1",
    horizon: "sequential" as const,
    idempotencyKey: "idem_1",
    reason: "",
    sampleSize: "",
    salt: "",
    targetingKey: "userId",
    targetingKeyType: "user",
    targetingRules: [],
  };

  it("drops a zero share, because that is the documented way to remove a Variant", () => {
    const input = buildRunStartInput({ ...base, allocation: { control: 100, treatment: 0 } });

    expect(input.draft.allocation).toEqual({ control: 100 });
  });

  it("throws rather than quietly dropping a Variant whose share is not finite", () => {
    expect(() =>
      buildRunStartInput({ ...base, allocation: { control: 100, treatment: Number.NaN } }),
    ).toThrow(/treatment.*not a finite number/);
  });
});

/**
 * The Run-start Start button reads `runDraftErrors`. Pinning it here is what
 * keeps a typo-shaped Entity type from enabling Start and then 400-ing with an
 * empty FieldError — reverting the shape check to nonempty-only must fail.
 */
describe("runDraftErrors", () => {
  const valid = {
    allocation: { control: 50, treatment: 50 },
    horizon: "sequential" as const,
    sampleSize: "",
    targetingKey: "userId",
    targetingKeyType: "user",
    targetingRules: "[]",
  };

  it("passes a complete draft", () => {
    expect(Object.values(runDraftErrors(valid)).every((message) => message === null)).toBe(true);
  });

  it("rejects a typo-shaped Entity type the Worker would reject", () => {
    expect(
      runDraftErrors({ ...valid, targetingKeyType: "delivery-driver" }).targetingKeyType,
    ).toMatch(/single underscores between segments/);
    expect(runDraftErrors({ ...valid, targetingKeyType: "User" }).targetingKeyType).toMatch(
      /single underscores between segments/,
    );
  });

  it("accepts a non-blessed Entity type that matches the Worker shape", () => {
    expect(runDraftErrors({ ...valid, targetingKeyType: "account" }).targetingKeyType).toBeNull();
  });

  it("names a blank Targeting Key", () => {
    expect(runDraftErrors({ ...valid, targetingKey: "  " }).targetingKey).toMatch(/Targeting Key/);
  });

  it("names a blank allocation share", () => {
    expect(
      runDraftErrors({ ...valid, allocation: { control: 100, treatment: Number.NaN } }).allocation,
    ).toMatch(/needs a number/);
  });

  it("names a fixed horizon without a sample size", () => {
    expect(runDraftErrors({ ...valid, horizon: "fixed", sampleSize: "" }).horizon).toMatch(
      /sample size/,
    );
  });

  it("names invalid Targeting Rules JSON", () => {
    expect(runDraftErrors({ ...valid, targetingRules: "{" }).targetingRules).toMatch(/valid JSON/);
  });
});
