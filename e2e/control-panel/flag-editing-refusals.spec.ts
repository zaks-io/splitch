import { expect, test } from "@playwright/test";
import {
  addRule,
  allowEnv,
  approvalGate,
  confirmEnv,
  expectApprovalRecord,
  expectUngated,
  editingFlags as flags,
  killSwitch,
  killSwitchState,
  openFlag,
  signIn,
} from "./flag-editing-actions";
import { captureThemeScreenshots } from "./screenshot";

/**
 * The two things the Flag detail screen must get right when the Worker says no,
 * or when nobody is allowed to say no (SPL-118).
 *
 * Incident control outranks every Policy and every running Experiment, and a
 * refusal has to arrive as itself: a generic "something went wrong" is a
 * disguised default, and a remedy the operator cannot perform is worse than none
 * (ADR-0036).
 */

test.describe("Incident control and Worker refusals", () => {
  test.beforeEach(({ context }) => signIn(context));

  test("turns a Flag off with no gate in a confirm-everything Environment", async ({
    page,
  }, testInfo) => {
    await openFlag(page, confirmEnv, flags.experimentLocked);
    // This Flag is owned by a running Experiment AND sits in an Environment whose
    // Policy confirms every change type. Neither may stand between an operator and
    // turning it off (ADR-0029).
    await expect(page.locator("[data-flag-experiment-banner]")).toBeVisible();
    if ((await killSwitchState(page)) === "disabled") {
      await killSwitch(page).click();
      await expect(approvalGate(page)).toBeVisible();
      await approvalGate(page).locator("[data-approval-confirm='true']").click();
      await expectApprovalRecord(page);
    }

    await killSwitch(page).click();

    await expectUngated(page);
    await expect(page.locator("[data-kill-switch-state]")).toHaveAttribute(
      "data-kill-switch-state",
      "disabled",
    );
    await captureThemeScreenshots(page, testInfo, "flag-editing-kill-switch-never-gated");
  });

  test("offers no control at all for a field a running Experiment owns", async ({ page }) => {
    await openFlag(page, confirmEnv, flags.experimentLocked);

    // Structurally absent, not disabled: a frozen-but-present control is one stray
    // click away from proposing a change the Worker would refuse.
    await expect(page.locator("[data-availability-input]")).toHaveCount(0);
    await expect(page.locator("[data-flag-targeting-editor]")).toHaveCount(0);
    await expect(page.locator("[data-flag-lock='true']").first()).toContainText(
      "owned by Experiment Edit Locked Run while it runs",
    );
    // The kill switch is the exception and stays live.
    await expect(killSwitch(page)).toBeEnabled();
  });

  test("renders the Worker's dangling-Variant refusal actionably", async ({ page }, testInfo) => {
    await openFlag(page, allowEnv, flags.danglingVariant);

    // `treatment` exists in the App-level catalog but was never made available in
    // this Environment, so a rule that serves it cannot be honoured.
    await addRule(page, "plan", "pro", "treatment");

    const refusal = page.locator("[data-refusal-code='VARIANT_NOT_AVAILABLE']");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("treatment");
    await expect(refusal.locator("[data-refusal-remedy='true']")).toContainText(
      "Make that Variant available in this Environment first",
    );
    // The refusal changed nothing: the rule list is still what the Worker holds.
    await expect(page.locator("tr[data-targeting-rule]").filter({ hasText: "plan" })).toHaveCount(
      0,
    );
    await captureThemeScreenshots(page, testInfo, "flag-editing-refusal");
  });
});
