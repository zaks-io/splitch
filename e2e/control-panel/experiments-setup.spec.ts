import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";
const setupPath = "/acme-labs/checkout-api/setup/experiments/experiment_checkout_setup_e2e/setup";

test.describe("Experiment Setup edit taxonomy", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("keeps safe edits inline and makes the next Run a named destructive flow", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.goto(setupPath);

    const setup = page.getByRole("region", { name: "Setup", exact: true });
    await expect(setup.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
    const frozen = page.getByTestId("frozen-assignment");
    await expect(frozen.getByText("Locked · Run 1")).toBeVisible();
    await expect(frozen.getByText("frozen for Run 1", { exact: false })).toBeVisible();
    await expect(frozen.locator("input, textarea, select")).toHaveCount(0);
    await expect(page.getByLabel("Conversion Window")).toHaveValue("24");
    await expect(page.getByRole("button", { name: "Save measurement", exact: true })).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "experiment-setup-frozen-and-editable");

    const runHistory = page.getByRole("region", { name: "Run history", exact: true });
    const runLinks = runHistory.getByRole("link", { name: /^Run \d/u });
    await expect(runLinks).toHaveCount(1);
    await page.getByLabel("Conversion Window").fill("48");
    const secondary = page.getByRole("group", { name: "Secondary Metrics", exact: true });
    await secondary.getByRole("checkbox", { name: /Order value/u }).uncheck();
    await page.getByRole("button", { name: "Save measurement", exact: true }).click();
    await expect(page.getByText("Measurement saved")).toBeVisible();
    await expect(page.getByText("Existing Run history is unchanged")).toBeVisible();
    await expect(runLinks).toHaveCount(1);
    await expect(page.getByText("Run 2", { exact: true })).toHaveCount(0);

    await page.getByLabel("Description").fill("Setup taxonomy verified end to end");
    await page.getByRole("button", { name: "Save details", exact: true }).click();
    await expect(page.getByText("Details saved")).toBeVisible();
    await expect(runLinks).toHaveCount(1);

    await page.getByRole("button", { name: "Configure Run 2", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Configure Run 2", exact: true })).toBeVisible();
    await expect(page.getByText("Nothing changes until Start is confirmed")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "experiment-setup-next-run-draft");
    await page.getByLabel("control").fill("60");
    await page.getByLabel("treatment").fill("40");
    await page.getByLabel("Why open this Run?").fill("Test a larger control allocation");
    await page.getByRole("button", { name: "Review Start", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Start Run 2?", exact: true })).toBeVisible();
    await expect(page.getByText("Run 1 will be abandoned")).toBeVisible();
    await expect(page.getByText("fresh sample from zero", { exact: false })).toBeVisible();
    await expect(page.getByText("Runs are never pooled", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Abandon Run 1 and Start Run 2", exact: true }).click();

    await expect(runHistory.getByRole("link", { name: /^Run 2/u })).toBeVisible();
    await expect(runHistory.getByRole("link", { name: /^Run 1/u })).toContainText("Ended");
    await expect(page.getByText("Allocation 50%/50% → 60%/40%")).toBeVisible();
    await expect(page.getByText("Note: Test a larger control allocation")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${setupPath}$`, "u"));
  });
});
