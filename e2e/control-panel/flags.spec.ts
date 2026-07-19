import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("per-Environment Flags", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("changes the Flag Configuration summary with the active Environment", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/dev/flags");

    const row = page.locator("[data-flag-key='new-checkout']");
    await expect(row).toContainText("Enabled");
    await expect(row).toContainText("2 of 2");
    await expect(row).toContainText("No percentage rollout");
    await captureThemeScreenshots(page, testInfo, "flags-list-dev");

    await chooseEnvironment(page, "/acme-labs/checkout-api/prod/flags");
    await expect(page).toHaveURL("/acme-labs/checkout-api/prod/flags");
    await expect(row).toContainText("Disabled");
    await expect(row).toContainText("1 of 2");
    await captureThemeScreenshots(page, testInfo, "flags-list-prod");
  });

  test("teaches the empty state", async ({ page }, testInfo) => {
    await page.goto("/acme-labs/billing-api/prod/flags");

    await expect(page.getByRole("heading", { name: "Flags" })).toBeVisible();
    await expect(page.getByText("Create your first Flag")).toBeVisible();
    await expect(page.getByText("A Flag is a named toggle with Variants.")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "flags-empty");
  });

  test("creates the boolean Flag through the Worker", async ({ page }, testInfo) => {
    const flagKey = `billing-refresh-${testInfo.retry}`;
    await page.goto("/acme-labs/billing-api/prod/flags");

    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Prefilled: disabled is the Default Variant; enabled is true."),
    ).toBeVisible();
    await expect(dialog.getByTestId("boolean-catalog").locator("[data-variant-name]")).toHaveText([
      "disabledfalseDefault",
      "enabledtrue",
    ]);

    await dialog.getByLabel("Flag key").fill(flagKey);
    await dialog.getByRole("button", { name: "Create Flag" }).click();
    await expect(dialog.getByRole("heading", { name: "Connect your code" })).toBeVisible();
    await expect(dialog.getByText(flagKey)).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "flags-create-success");

    await dialog
      .locator("[data-slot='dialog-footer']")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.locator(`[data-flag-key='${flagKey}']`)).toContainText("Not configured");
    await captureThemeScreenshots(page, testInfo, "flags-list");

    await page.getByRole("button", { name: "Create Flag" }).click();
    await page.getByRole("dialog").getByLabel("Flag key").fill(flagKey);
    await page.getByRole("dialog").getByRole("button", { name: "Create Flag" }).click();
    await expect(page.getByText("flag key already exists in this App")).toBeVisible();
    await expect(page.getByLabel("Flag key")).toHaveAttribute("aria-invalid", "true");
  });
});

async function chooseEnvironment(page: import("@playwright/test").Page, href: string) {
  const switcher = page
    .locator("details")
    .filter({ has: page.getByText("Environment", { exact: true }) });
  await switcher.locator("summary").click();
  await switcher.locator(`a[href='${href}']`).click();
}
