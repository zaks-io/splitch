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
 * The Flag-editing matrix (SPL-118).
 *
 * Every test writes through the real Worker: the Panel proposes and the Control
 * Plane decides. The two halves send the SAME gesture to the SAME Flag and differ
 * only in which Environment they send it to, so a gate that appears is the
 * Environment Policy talking, not the screen guessing.
 *
 * Directions are read off the rendered state before each click rather than
 * hard-coded, because these tests mutate durable fixture rows: a retry starts
 * from whatever the previous attempt left behind.
 */

test.describe("Flag editing under an allowing Policy", () => {
  test.beforeEach(({ context }) => signIn(context));

  test("flips the kill switch with no gate", async ({ page }, testInfo) => {
    await openFlag(page, allowEnv, flags.enabledState);
    const before = await killSwitchState(page);

    await killSwitch(page).click();

    await expectUngated(page);
    await expect(page.locator("[data-kill-switch-state]")).toHaveAttribute(
      "data-kill-switch-state",
      before === "enabled" ? "disabled" : "enabled",
    );
    await captureThemeScreenshots(page, testInfo, "flag-editing-allow-applied");
  });

  test("changes Variant availability with no gate", async ({ page }) => {
    await openFlag(page, allowEnv, flags.availability);
    const toggle = page.locator("[data-availability-input='treatment']");
    const wasAvailable = await toggle.isChecked();

    await toggle.click();

    await expectUngated(page);
    await expect(page.locator("[data-flag-availability]")).toContainText(
      wasAvailable ? "1 of 2" : "2 of 2",
    );
  });

  test("sets the baseline rollout with no gate", async ({ page }, testInfo) => {
    const percentage = 20 + testInfo.retry;
    await openFlag(page, allowEnv, flags.rollout);

    await page.locator("[data-baseline-input='true']").fill(String(percentage));
    await page.locator("[data-baseline-save='true']").click();

    await expectUngated(page);
    await expect(page.locator("[data-baseline-current='true']")).toContainText(
      `${percentage}% of traffic`,
    );
    // The bucketing salt is minted by the Worker and is never operator-facing.
    await expect(page.locator("body")).not.toContainText("salt");
  });

  test("adds and removes a Targeting Rule with no gate", async ({ page }, testInfo) => {
    const attribute = `plan${testInfo.retry}`;
    await openFlag(page, allowEnv, flags.targeting);

    await addRule(page, attribute, "pro", "treatment");

    await expectUngated(page);
    const rule = page.locator("tr[data-targeting-rule]").filter({ hasText: attribute });
    await expect(rule).toHaveCount(1);
    // A new rule carries no percentage, so it must not claim one.
    await expect(rule).toContainText("All matches");

    await rule.locator("[data-targeting-remove]").click();

    await expectUngated(page);
    await expect(
      page.locator("tr[data-targeting-rule]").filter({ hasText: attribute }),
    ).toHaveCount(0);
  });
});

test.describe("Flag editing under a confirming Policy", () => {
  test.beforeEach(({ context }) => signIn(context));

  test("gates enabling the Flag and records the Approval Request", async ({ page }, testInfo) => {
    await openFlag(page, confirmEnv, flags.enabledState);
    // Only turning a Flag ON is gated; turning it off is incident control and is
    // never gated, so a retry that inherits an enabled Flag turns it off first.
    if ((await killSwitchState(page)) === "enabled") {
      await killSwitch(page).click();
      await expectUngated(page);
    }

    await killSwitch(page).click();

    const gate = approvalGate(page);
    await expect(gate).toBeVisible();
    await expect(gate).toContainText("Enable this Flag in this Environment");
    // The diff is the Worker's own, rendered as before/after rows rather than JSON.
    const row = gate.locator("[data-approval-diff-path='/enabled']");
    await expect(row).toContainText("Disabled");
    await expect(row).toContainText("Enabled");
    await captureThemeScreenshots(page, testInfo, "flag-editing-confirm-gate");

    await gate.locator("[data-approval-confirm='true']").click();

    await expectApprovalRecord(page);
    await expect(page.locator("[data-kill-switch-state]")).toHaveAttribute(
      "data-kill-switch-state",
      "enabled",
    );
    await captureThemeScreenshots(page, testInfo, "flag-editing-confirm-applied");
  });

  test("gates a Variant availability change", async ({ page }) => {
    await openFlag(page, confirmEnv, flags.availability);
    const toggle = page.locator("[data-availability-input='treatment']");
    const wasAvailable = await toggle.isChecked();

    await toggle.click();

    const gate = approvalGate(page);
    await expect(gate).toContainText("Available Variants");
    await expect(gate.locator("[data-approval-diff-path='/availableVariantNames']")).toBeVisible();
    await gate.locator("[data-approval-confirm='true']").click();

    await expectApprovalRecord(page);
    await expect(page.locator("[data-flag-availability]")).toContainText(
      wasAvailable ? "1 of 2" : "2 of 2",
    );
  });

  test("gates a baseline rollout change", async ({ page }, testInfo) => {
    const percentage = 40 + testInfo.retry;
    await openFlag(page, confirmEnv, flags.rollout);

    await page.locator("[data-baseline-input='true']").fill(String(percentage));
    await page.locator("[data-baseline-save='true']").click();

    const gate = approvalGate(page);
    await expect(gate).toContainText("Baseline rollout");
    await expect(gate).toContainText(`${percentage}% of traffic`);
    // Even inside the gate the server-minted salt stays out of the operator's face.
    await expect(gate).not.toContainText("Bucketing salt");
    await gate.locator("[data-approval-confirm='true']").click();

    await expectApprovalRecord(page);
    await expect(page.locator("[data-baseline-current='true']")).toContainText(
      `${percentage}% of traffic`,
    );
  });

  test("gates a Targeting Rule change", async ({ page }) => {
    await openFlag(page, confirmEnv, flags.targeting);
    const existing = await page.locator("tr[data-targeting-rule]").count();

    await addRule(page, "country", "CA", "treatment");

    const gate = approvalGate(page);
    await expect(gate).toContainText("Targeting Rules");
    await expect(
      gate.locator(
        "[data-approval-diff-group='Targeting Rules'] [data-approval-diff-after='true']",
      ),
    ).toContainText("serves treatment");
    await gate.locator("[data-approval-confirm='true']").click();

    await expectApprovalRecord(page);
    await expect(page.locator("tr[data-targeting-rule]")).toHaveCount(existing + 1);
  });

  test("leaves the proposal pending when the operator cancels", async ({ page }) => {
    await openFlag(page, confirmEnv, flags.availability);
    const toggle = page.locator("[data-availability-input='treatment']");
    const wasAvailable = await toggle.isChecked();

    await toggle.click();
    const gate = approvalGate(page);
    // Cancelling is honest about what it does and does not undo: the Approval
    // Request is already on file, and the screen says so rather than implying the
    // proposal evaporated.
    await expect(gate).toContainText("Cancelling leaves the proposal pending in the audit log");
    await gate.getByRole("button", { name: "Cancel" }).click();

    await expect(gate).toHaveCount(0);
    // No optimistic update: the switch still shows what the Worker last confirmed.
    await expect(toggle).toBeChecked({ checked: wasAvailable });
  });
});
