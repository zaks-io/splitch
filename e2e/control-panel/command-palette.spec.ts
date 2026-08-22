import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("Control Panel command palette", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("jumps to a Flag with the keyboard", async ({ page }, testInfo) => {
    await openAppPage(page, "/acme-labs/checkout-api/dev");

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator("[data-command-palette]")).toBeVisible();
    await expect(page.locator("[data-palette-item='flag:new-checkout']")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "command-palette");
    await page.keyboard.type("new-checkout");
    await expect(page.locator("[data-palette-item='flag:new-checkout']")).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL("/acme-labs/checkout-api/dev/flags/new-checkout");
  });

  test("jumps to an Experiment with the keyboard", async ({ page }) => {
    await openAppPage(page, "/acme-labs/checkout-api/dev");

    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("Checkout Copy Dev");
    await expect(
      page.locator("[data-palette-item='experiment:experiment_checkout_dev_e2e']"),
    ).toBeVisible();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(
      "/acme-labs/checkout-api/dev/experiments/experiment_checkout_dev_e2e",
    );
  });

  test("opens from Home and jumps to an App", async ({ page }) => {
    await page.goto("/acme-labs");
    await expect(page.locator("[data-org-shell='ready']")).toBeVisible();
    await waitForHydration(page);

    await page.locator("[data-command-palette-trigger]").click();
    await expect(page.locator("[data-palette-item='app:checkout-api']")).toBeVisible();
    await expect(page.locator("[data-palette-item^='flag:']")).toHaveCount(0);
    await page.keyboard.type("checkout-api");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL("/acme-labs/checkout-api");
  });

  test("opens Create Flag from the App home", async ({ page }) => {
    await openAppPage(page, "/acme-labs/checkout-api");

    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("New Flag");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Create Flag" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("closes with Escape and returns focus to the page", async ({ page }) => {
    await openAppPage(page, "/acme-labs/checkout-api/dev");

    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator("[data-command-palette]")).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(page.locator("[data-command-palette]")).toBeHidden();
    expect(
      await page.evaluate(() => document.activeElement?.closest("[data-command-palette]") === null),
    ).toBe(true);
  });
});

async function openAppPage(page: import("@playwright/test").Page, path: string) {
  await page.goto(path);
  await expect(page.locator("[data-app-shell='ready']")).toBeVisible();
  await waitForHydration(page);
}
