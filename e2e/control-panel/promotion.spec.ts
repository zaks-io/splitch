import { expect, test } from "@playwright/test";
import {
  approvalGate,
  confirmGateAndExpectRecord,
  openPromotion,
  promotionFlags as flags,
  renderedSelect,
  row,
  signIn,
  sourceEnv,
  submitAndCaptureSelect,
  targetEnv,
  tick,
  tickedRowIds,
} from "./promotion-actions";
import { captureThemeScreenshots } from "./screenshot";

/**
 * The Promotion screen (SPL-122).
 *
 * Every test here asserts the same invariant from a different selection: the
 * `select` on the wire equals the `select` the screen rendered, and every name in
 * it traces to a row the operator could see ticked. The target Environment's
 * Policy is `confirm` on everything, so each promotion also has to survive the
 * Approval Request gate it produces.
 */

test.describe("Promotion", () => {
  test.beforeEach(({ context }) => signIn(context));

  test("promotes the whole Flag Configuration as one Approval Request", async ({
    page,
  }, testInfo) => {
    await openPromotion(page, flags.wholeConfig);

    // The hero shot is the diff itself, so it is captured with the whole config
    // pre-ticked and before anything is sent.
    await page.locator("[data-promotion-preset='whole']").click();
    await expect(page.locator("[data-promotion-row-selected='true']")).toHaveCount(4);
    await captureThemeScreenshots(page, testInfo, "promotion-diff");

    expect(await tickedRowIds(page)).toEqual([
      "availability:beta",
      "targeting",
      "rollout",
      "enabled",
    ]);
    const shown = await renderedSelect(page);
    expect(shown).toEqual({
      availability: ["beta"],
      targeting: true,
      rollout: true,
      enabled: true,
    });

    expect(await submitAndCaptureSelect(page)).toEqual(shown);
    await confirmGateAndExpectRecord(page);
  });

  test("promotes one Variant's availability and nothing else", async ({ page }) => {
    await openPromotion(page, flags.singleVariant);

    await page.locator("[data-promotion-preset='variant:beta']").click();

    expect(await tickedRowIds(page)).toEqual(["availability:beta"]);
    const shown = await renderedSelect(page);
    // Absence is the contract: the three untouched field groups are OMITTED, not
    // sent as false, so the target keeps its own targeting, rollout, and enabled.
    expect(shown).toEqual({ availability: ["beta"] });

    expect(await submitAndCaptureSelect(page)).toEqual(shown);
    await confirmGateAndExpectRecord(page);
  });

  test("promotes availability alone while the rest of the diff stays visible", async ({ page }) => {
    await openPromotion(page, flags.availabilityOnly);

    await page.locator("[data-promotion-preset='availability']").click();

    // The unticked rows are still on screen. A preset narrows the payload; it must
    // never hide the difference it is declining to promote.
    await expect(row(page, "targeting")).toBeVisible();
    await expect(row(page, "rollout")).toBeVisible();
    await expect(row(page, "enabled")).toBeVisible();
    await expect(row(page, "targeting")).toHaveAttribute("data-promotion-row-selected", "false");

    const shown = await renderedSelect(page);
    expect(shown).toEqual({ availability: ["beta"] });
    expect(await submitAndCaptureSelect(page)).toEqual(shown);
    await confirmGateAndExpectRecord(page);
  });

  test("offers the dependency, never applies it, and lets the Worker refuse", async ({
    page,
  }, testInfo) => {
    await openPromotion(page, flags.danglingVariant);

    // Promoting the rules alone leaves them serving `beta`, which is not available
    // in the target. The panel offers the fix; it does not silently tick it.
    await tick(page, "targeting").click();

    const nudge = page.locator("[data-promotion-nudge='beta']");
    await expect(nudge).toBeVisible();
    await expect(nudge).toContainText("beta");
    await expect(nudge).toHaveAttribute("data-promotion-nudge-remedy", "tick");
    await expect(row(page, "availability:beta")).toHaveAttribute(
      "data-promotion-row-selected",
      "false",
    );
    expect(await renderedSelect(page)).toEqual({ targeting: true });
    await captureThemeScreenshots(page, testInfo, "promotion-dependency-nudge");

    // Offer in the panel, block at the Worker (ADR-0028/0036). Submitting anyway
    // has to produce the structured refusal, not a gate and not a silent success.
    expect(await submitAndCaptureSelect(page)).toEqual({ targeting: true });

    const refusal = page.locator("[data-refusal-code='VARIANT_NOT_AVAILABLE']");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("beta");
    await expect(approvalGate(page)).toHaveCount(0);
    await captureThemeScreenshots(page, testInfo, "promotion-dependency-refusal");
  });

  test("accepts the offered dependency and then promotes cleanly", async ({ page }) => {
    await openPromotion(page, flags.danglingVariant);
    await tick(page, "targeting").click();

    await page.locator("[data-promotion-nudge-apply='beta']").click();

    await expect(page.locator("[data-promotion-nudge='beta']")).toHaveCount(0);
    const shown = await renderedSelect(page);
    expect(shown).toEqual({ availability: ["beta"], targeting: true });
    expect(await submitAndCaptureSelect(page)).toEqual(shown);
    await confirmGateAndExpectRecord(page);
  });

  test("names both Environments and frames the write as a pull into the target", async ({
    page,
  }) => {
    await openPromotion(page, flags.framing);

    await expect(page.locator(`[data-promotion-source='${sourceEnv}']`)).toBeVisible();
    await expect(page.locator(`[data-promotion-target='${targetEnv}']`)).toBeVisible();
    await expect(page.locator("[data-promotion-submit='true']")).toContainText(
      `Promote into ${targetEnv}`,
    );
    // Nothing is ticked on arrival: a screen that pre-selects a write is a screen
    // that can be submitted before it is read.
    expect(await tickedRowIds(page)).toEqual([]);
    await expect(page.locator("[data-promotion-submit='true']")).toBeDisabled();
  });
});
