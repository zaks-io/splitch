import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";
const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The rigor contract as pixels.
 *
 * These tests exist to prove two things that are easy to regress: a warning
 * state never withholds the numbers, and the ship decision is refused by the
 * Worker with the failing check named, with no way around it.
 */

test.describe("Experiment Results tab", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("shows the lift plot and allows a decision on a clean, powered Run", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(
      "/acme-labs/checkout-api/dev/experiments/experiment_checkout_significance_e2e/results",
    );

    await expect(page.getByRole("heading", { name: "Lift by arm" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Relative lift with confidence/ })).toBeVisible();
    const srm = page.locator('[data-srm-tier="clean"]');
    await expect(srm.getByText("Balanced").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Conclude and promote winner" })).toBeEnabled();
    await expect(page.getByText(/Enforced by control-plane-api/)).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "experiment-results-clean");
  });

  test("keeps every number visible while a Sample Ratio Mismatch is firing", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/acme-labs/checkout-api/prod/experiments/experiment_checkout_srm_e2e/results");

    const srm = page.locator('[data-srm-tier="confirmed"]');
    await expect(srm).toBeVisible();
    await expect(srm.getByText("Confirmed mismatch").first()).toBeVisible();

    // The warning qualifies the numbers; it never replaces them.
    await expect(page.getByRole("img", { name: /Relative lift with confidence/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Lift by arm" })).toBeVisible();
    await expect(srm.getByRole("columnheader", { name: "Observed" })).toBeVisible();
    await expect(page.getByText(/Exposures control/)).toBeVisible();

    const blocked = page.getByTestId("ship-blocked");
    await expect(blocked).toContainText("Sample Ratio Mismatch is firing");
    // This Run is also too small to call, and the refusal names both checks.
    await expect(blocked).toContainText("Result is underpowered");
    await expect(page.getByRole("button", { name: "Conclude and promote winner" })).toBeDisabled();

    await captureThemeScreenshots(page, testInfo, "experiment-results-srm-warning");
  });

  // This Experiment carries no Metric and only 20 Exposures, so it fails on both
  // counts. The refusal must name each one rather than a generic "not ready".
  test("refuses the decision on an underpowered Run and names every failing check", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto("/acme-labs/checkout-api/dev/experiments/experiment_checkout_dev_e2e/results");

    const blocked = page.getByTestId("ship-blocked");
    await expect(blocked).toContainText("Result is underpowered");
    await expect(blocked).toContainText("No decision-valid result");
    await expect(page.getByRole("button", { name: "Conclude and promote winner" })).toBeDisabled();
    await expect(page.getByText(/Enforced by control-plane-api/)).toBeVisible();
    // Guardrails and health are reported beside the refusal, not instead of it.
    await expect(page.getByText("__multiple__ quarantine rate")).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "experiment-results-gated");
  });

  test("tells a draft Experiment there is nothing to measure yet", async ({ page }) => {
    await page.goto(
      "/acme-labs/checkout-api/dev/experiments/experiment_checkout_draft_e2e/results",
    );

    await expect(page.getByText(/no Run yet/)).toBeVisible();
  });

  test("ships no way around the gate", () => {
    const sources = [
      "apps/control-panel/src/components/experiment-results.tsx",
      "apps/control-panel/src/components/experiment-results-decision.tsx",
      "apps/control-panel/src/components/experiment-results-panel.tsx",
      "apps/control-panel/src/components/experiment-results-srm.tsx",
      "apps/control-panel/src/components/experiment-results-guardrails.tsx",
    ].map((path) => readFileSync(resolve(repoRoot, path), "utf8").toLowerCase());

    for (const source of sources) {
      expect(source).not.toMatch(/ship anyway|force ship|proceed anyway|bypass the gate/);
    }
  });
});
