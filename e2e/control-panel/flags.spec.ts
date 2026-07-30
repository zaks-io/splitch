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
    await expect(row.getByRole("link", { name: "new-checkout" })).toHaveCount(1);
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

    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    // The on/off pair is the zero-configuration preset: a new Flag opens ready
    // to submit, so the operator never has to touch the Variant editor.
    const catalog = dialog.getByTestId("variant-catalog");
    await expect(catalog.locator("[data-variant-name]")).toHaveCount(2);
    await expect(dialog.getByLabel("Variant value type")).toHaveValue("boolean");
    await expect(catalog.locator("#variant-name-0")).toHaveValue("disabled");
    await expect(catalog.locator("#variant-value-0")).toHaveValue("false");
    await expect(catalog.locator("#variant-default-0")).toBeChecked();
    await expect(catalog.locator("#variant-name-1")).toHaveValue("enabled");
    await expect(catalog.locator("#variant-value-1")).toHaveValue("true");

    await dialog.getByLabel("Flag key").fill(flagKey);
    await dialog.getByRole("button", { name: "Create Flag" }).click();
    await expect(dialog.getByRole("heading", { name: "Connect your code" })).toBeVisible();
    // Exact: the Connect card and the verify hint also substitute the Flag Key
    // into the snippet and the CLI equivalent, so a substring match is ambiguous.
    await expect(dialog.getByText(flagKey, { exact: true })).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "flags-create-success");

    await dialog
      .locator("[data-slot='dialog-footer']")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.locator(`[data-flag-key='${flagKey}']`)).toContainText("Disabled");
    await expect(page.locator(`[data-flag-key='${flagKey}']`)).toContainText("All 2, not narrowed");
    await captureThemeScreenshots(page, testInfo, "flags-list");

    await page.getByRole("button", { name: "Create Flag" }).click();
    await page.getByRole("dialog").getByLabel("Flag key").fill(flagKey);
    await page.getByRole("dialog").getByRole("button", { name: "Create Flag" }).click();
    await expect(page.getByText("flag key already exists in this App")).toBeVisible();
    await expect(page.getByLabel("Flag key")).toHaveAttribute("aria-invalid", "true");
  });

  test("creates a three-Variant string Flag through the Worker", async ({ page }, testInfo) => {
    const flagKey = `checkout-copy-${testInfo.retry}`;
    await page.goto("/acme-labs/billing-api/prod/flags");

    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    const catalog = dialog.getByTestId("variant-catalog");

    await dialog.getByLabel("Flag key").fill(flagKey);
    // No confirm here: "false"/"true" are valid strings, so the switch preserves
    // them and the fills below just overwrite. Only a switch to number or object
    // discards values and prompts.
    await dialog.getByLabel("Variant value type").selectOption("string");

    await catalog.locator("#variant-name-0").fill("control");
    await catalog.locator("#variant-value-0").fill("Buy now");
    await catalog.locator("#variant-name-1").fill("urgent");
    await catalog.locator("#variant-value-1").fill("Buy now, limited stock");

    await dialog.getByRole("button", { name: "Add Variant" }).click();
    await catalog.locator("#variant-name-2").fill("calm");
    await catalog.locator("#variant-value-2").fill("Add to cart");
    await expect(catalog.locator("[data-variant-name]")).toHaveCount(3);

    await catalog.locator("#variant-default-1").check();
    await captureThemeScreenshots(page, testInfo, "flags-create-variant-catalog");

    await dialog.getByRole("button", { name: "Create Flag" }).click();
    await expect(dialog.getByRole("heading", { name: "Connect your code" })).toBeVisible();
    await dialog
      .locator("[data-slot='dialog-footer']")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.locator(`[data-flag-key='${flagKey}']`)).toContainText("All 3, not narrowed");
  });
});

test.describe("Flag detail", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("shows the same Flag's divergent Configuration in each Environment", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/dev/flags");
    await page.locator("[data-flag-key='new-checkout']").getByRole("link").click();
    await expect(page).toHaveURL("/acme-labs/checkout-api/dev/flags/new-checkout");

    // The list is replaced, not stacked above: the detail is the section's view now.
    await expect(page.getByRole("heading", { level: 1, name: "New Checkout" })).toBeVisible();
    await expect(page.locator("[data-flag-key='new-checkout']")).toHaveCount(0);

    const devConfig = page.locator("[data-flag-env-config='dev']");
    await expect(devConfig).toContainText("Enabled");
    await expect(devConfig).toContainText("2 of 2 catalog Variants available here");
    // Both Variants are promoted into dev, so neither is marked unavailable here.
    await expect(page.locator("[data-variant-availability='unavailable']")).toHaveCount(0);
    // The salt behind a percentage rollout is server-minted and never operator-facing.
    await expect(page.locator("body")).not.toContainText("salt");
    await captureThemeScreenshots(page, testInfo, "flag-detail-dev");

    await chooseEnvironment(page, "/acme-labs/checkout-api/prod/flags/new-checkout");
    await expect(page).toHaveURL("/acme-labs/checkout-api/prod/flags/new-checkout");

    const prodConfig = page.locator("[data-flag-env-config='prod']");
    await expect(prodConfig).toContainText("Disabled");
    await expect(prodConfig).toContainText("1 of 2 catalog Variants available here");
    await captureThemeScreenshots(page, testInfo, "flag-detail-prod");
  });

  test("marks a Variant that was never promoted into this Environment", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/prod/flags/new-checkout");

    const treatment = page.locator("[data-variant-name='treatment']");
    await expect(treatment).toHaveAttribute("data-variant-availability", "unavailable");
    await expect(treatment).toContainText("Not available");
    // The toggle STATE is rendered so the App-level/per-Environment split is legible,
    // but nothing on this read-only screen is togglable.
    const toggle = treatment.getByRole("switch");
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();

    const control = page.locator("[data-variant-name='control']");
    await expect(control).toHaveAttribute("data-variant-availability", "available");
    await expect(control.getByRole("switch")).toBeChecked();
    await expect(control.getByRole("switch")).toBeDisabled();

    await expect(page.getByText("Definition — shared across all environments")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "flag-detail-variant-availability");
  });

  test("banners the running Experiment and never locks the kill switch", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/dev/flags/new-checkout");

    const banner = page.locator("[data-flag-experiment-banner]");
    await expect(banner).toContainText("Controlled by Experiment");
    await expect(banner.getByRole("link", { name: "Checkout Copy Dev" })).toBeVisible();
    await expect(page.locator("[data-flag-lock='true']").first()).toContainText(
      "owned by Experiment Checkout Copy Dev while it runs",
    );
    await expect(page.locator("[data-flag-kill-switch='true']")).toContainText("Never locked");
    await expect(
      page.locator("[data-flag-kill-switch='true'] [data-flag-lock='true']"),
    ).toHaveCount(0);
    await captureThemeScreenshots(page, testInfo, "flag-detail-experiment-locked");
  });

  test("does not claim control for a draft or an ended Experiment", async ({ page }) => {
    for (const flagKey of ["checkout-draft", "checkout-ended"]) {
      await page.goto(`/acme-labs/checkout-api/dev/flags/${flagKey}`);

      await expect(page.locator("[data-flag-env-config='dev']")).toBeVisible();
      await expect(page.locator("[data-flag-experiment-banner]")).toHaveCount(0);
      await expect(page.locator("[data-flag-lock='true']")).toHaveCount(0);
    }
  });

  test("renders a normally created Flag with no fixture-seeded Configuration", async ({
    page,
  }, testInfo) => {
    const flagKey = `detail-honest-${testInfo.retry}`;
    await page.goto("/acme-labs/billing-api/prod/flags");
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");

    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Flag key").fill(flagKey);
    await dialog.getByRole("button", { name: "Create Flag" }).click();
    await expect(dialog.getByRole("heading", { name: "Connect your code" })).toBeVisible();
    await dialog
      .locator("[data-slot='dialog-footer']")
      .getByRole("button", { name: "Close" })
      .click();

    await page.locator(`[data-flag-key='${flagKey}']`).getByRole("link").click();
    await expect(page).toHaveURL(`/acme-labs/billing-api/prod/flags/${flagKey}`);

    const config = page.locator("[data-flag-env-config='prod']");
    await expect(config).toContainText("Disabled");
    // An untouched availability set means "not narrowed", which is the opposite of
    // "nothing can serve here". The screen has to say which one it is.
    await expect(page.locator("[data-flag-availability='not-narrowed']")).toContainText(
      "every Variant in the catalog is a candidate",
    );
    await expect(page.locator("[data-flag-experiment-banner]")).toHaveCount(0);
    await expect(config).toContainText("No Targeting Rules in this Environment.");
    await captureThemeScreenshots(page, testInfo, "flag-detail-newly-created");
  });

  test("does not invent a Flag for an unknown key", async ({ page }) => {
    await page.goto("/acme-labs/checkout-api/dev/flags/no-such-flag");

    await expect(page.getByText("Flag not found")).toBeVisible();
    await expect(page.locator("[data-flag-env-config='dev']")).toHaveCount(0);
  });
});

async function chooseEnvironment(page: import("@playwright/test").Page, href: string) {
  const switcher = page
    .locator("details")
    .filter({ has: page.getByText("Environment", { exact: true }) });
  await switcher.locator("summary").click();
  await switcher.locator(`a[href='${href}']`).click();
}
