import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
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
    await expect(page.getByRole("link", { name: "Checkout Draft" })).toHaveAttribute(
      "href",
      "/acme-labs/checkout-api/dev/experiments/experiment_checkout_draft_e2e",
    );
    await expect(page.getByText("Draft", { exact: true })).toBeVisible();
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Ended", { exact: true })).toBeVisible();
    await expect(page.getByText("New Checkout", { exact: true })).toBeVisible();
    await expect(page.getByText("Collecting data", { exact: true })).toBeVisible();
    await expect(page.getByText("Significance reached", { exact: true })).toBeVisible();
    await expect(page.getByText("Guardrail breached", { exact: true })).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "experiments-list");

    await page.goto("/acme-labs/checkout-api/prod/experiments");
    await expect(page.getByText("SRM firing", { exact: true })).toBeVisible();
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
});
