import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("Control Panel Experiments", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("renders per-Environment lifecycle and exact Run health", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/acme-labs/checkout-api/dev/experiments");

    await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New Experiment" })).toHaveAttribute(
      "href",
      "/acme-labs/checkout-api/dev/experiments/new",
    );
    // A draft has no Run, so its row links into the creation flow rather than at
    // a detail screen whose Results and Setup tabs would have nothing behind them.
    await expect(page.getByRole("link", { name: "Checkout Draft" })).toHaveAttribute(
      "href",
      "/acme-labs/checkout-api/dev/experiments/experiment_checkout_draft_e2e/draft",
    );
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Ended", { exact: true })).toBeVisible();
    await expect(page.getByText("New Checkout", { exact: true })).toBeVisible();

    // Scope each health assertion to its own Run row: three Experiments are
    // "running" in this Environment, and only one of them should show any
    // given health. Asserting on `getByText` alone proves the text exists
    // somewhere on the page, not which Run it belongs to.
    const devRow = page.locator('[data-experiment-id="experiment_checkout_dev_e2e"]');
    await expect(devRow.getByText("Collecting data", { exact: true })).toBeVisible();

    const significanceRow = page.locator(
      '[data-experiment-id="experiment_checkout_significance_e2e"]',
    );
    await expect(significanceRow.getByText("Significance reached", { exact: true })).toBeVisible();

    const guardrailRow = page.locator('[data-experiment-id="experiment_checkout_guardrail_e2e"]');
    await expect(guardrailRow.getByText("Guardrail breached", { exact: true })).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "experiments-list");

    await page.goto("/acme-labs/checkout-api/prod/experiments");
    await expect(page.getByText("SRM firing", { exact: true }).first()).toBeVisible();
  });

  test("teaches the Experiment concept in an empty Environment", async ({ page }) => {
    await page.goto("/acme-labs/billing-api/prod/experiments");

    await expect(page.getByText("Create your first Experiment", { exact: true })).toBeVisible();
    await expect(page.getByText(/Start its first Run/)).toBeVisible();
    await expect(page.getByText("splitch experiments create", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "New Experiment" })).toHaveAttribute(
      "href",
      "/acme-labs/billing-api/prod/experiments/new",
    );
  });

  test("pins frozen Runs in the URL and keeps the current tab", async ({
    browser,
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/acme-labs/checkout-api/dev/experiments/experiment_checkout_dev_e2e");

    await expect(page.getByRole("heading", { name: "Checkout Copy Dev" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Results" })).toBeVisible();
    await expect(page.getByText("Allocation 50%/50% → 70%/30%")).toBeVisible();
    await expect(page.getByText("Note: Increase treatment traffic")).toBeVisible();
    await expect(page.getByText("End note: Prepared a larger treatment allocation")).toBeVisible();
    await expect(page.getByRole("link", { name: /Run 2/ })).toHaveAttribute("aria-current", "page");
    await captureThemeScreenshots(page, testInfo, "experiment-detail");

    await page.getByRole("link", { name: /Run 1/ }).click();
    await expect(page).toHaveURL(
      /\/experiments\/experiment_checkout_dev_e2e\/runs\/run_checkout_dev_previous_e2e\/results$/u,
    );
    await expect(page.getByRole("link", { name: /Run 1/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Measured on Run 1 alone")).toBeVisible();
    // Run 1 seeded 6 Exposures per arm and the live Run 2 seeded 10. A results
    // read that served the live Run's rows under this frozen Run's heading would
    // otherwise pass every assertion above.
    await expect(page.getByText(/Exposures control 6 · treatment 6/)).toBeVisible();

    await page.getByRole("link", { name: "Setup", exact: true }).click();
    await page.getByRole("link", { name: /Run 2/ }).click();
    await expect(page).toHaveURL(
      /\/experiments\/experiment_checkout_dev_e2e\/runs\/run_checkout_dev_e2e\/setup$/u,
    );
    await expect(page.getByText("frozen for Run 2", { exact: false })).toBeVisible();

    const secondUser = await browser.newContext();
    await secondUser.addCookies([
      { name: "__session", value: LOCAL_E2E_MEMBER_SESSION_TOKEN, url: origin },
    ]);
    const pastedLink = await secondUser.newPage();
    await pastedLink.goto(
      "/acme-labs/checkout-api/dev/experiments/experiment_checkout_dev_e2e/runs/run_checkout_dev_previous_e2e/results",
    );
    await expect(pastedLink.getByRole("link", { name: /Run 1/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(pastedLink.getByText("Measured on Run 1 alone")).toBeVisible();
    await secondUser.close();
  });

  test("lands a draft Experiment on Setup", async ({ page }) => {
    await page.goto("/acme-labs/checkout-api/dev/experiments/experiment_checkout_draft_e2e");

    await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Setup", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText("No Runs yet")).toBeVisible();
  });
});
