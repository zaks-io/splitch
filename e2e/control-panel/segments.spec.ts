import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("App-level Segments", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("shows the same App-level definitions from every Environment", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/dev/segments");

    await expect(page.getByRole("heading", { name: "Segments (App-level)" })).toBeVisible();
    await expect(page.getByText("Defined once, available in every Environment")).toBeVisible();
    await expect(page.getByText(/A Segment is a reusable set of Conditions/)).toBeVisible();
    await expect(page.locator("[data-segment-name='Paid plan']")).toBeVisible();
    await expect(page.locator("[data-segment-name='Enterprise markets']")).toBeVisible();
    await expect(page.locator("[data-segment-name='Paid plan']")).toContainText("plan equals paid");
    await captureThemeScreenshots(page, testInfo, "segments-app-level");

    await page.goto("/acme-labs/checkout-api/prod/segments");
    await expect(page.locator("[data-segment-name='Paid plan']")).toBeVisible();
    await expect(page.locator("[data-segment-name='Enterprise markets']")).toBeVisible();
  });

  test("round-trips Conditions and surfaces Worker validation", async ({ page }, testInfo) => {
    const suffix = `${testInfo.retry}`;
    const name = `Beta cohort ${suffix}`;

    await page.goto("/acme-labs/billing-api/prod/segments");
    await waitForHydration(page);
    await expect(page.locator(`[data-segment-name='${name}']`)).toHaveCount(0);

    await page.getByRole("button", { name: "Create Segment" }).click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog.getByText(/Defined once for this App/)).toBeVisible();
    await createDialog.getByRole("button", { name: "Create Segment" }).click();
    await expect(createDialog.getByText("Enter a Segment name.")).toBeVisible();
    await expect(createDialog.getByText("Enter an attribute.")).toBeVisible();

    await createDialog.getByLabel("Segment name").fill(name);
    await createDialog.getByLabel("Attribute").fill("plan");
    await createDialog.getByLabel("Value", { exact: true }).fill("beta");
    await createDialog.getByRole("button", { name: "Add Condition" }).click();
    const secondAttribute = createDialog.locator("#segment-condition-1-attribute");
    await secondAttribute.fill("country");
    await createDialog.locator("#segment-condition-1-operator").click();
    await page.getByRole("option", { name: "in list", exact: true }).click();
    await createDialog.locator("#segment-condition-1-value-0").fill("US");
    await createDialog.getByRole("button", { name: "Add value" }).click();
    await createDialog.locator("#segment-condition-1-value-1").fill("CA");
    await createDialog.getByRole("button", { name: "Create Segment" }).click();
    await expect(createDialog).toBeHidden();
    await expect(page.locator(`[data-segment-name='${name}']`)).toBeVisible();
    await expect(page.locator(`[data-segment-name='${name}']`)).toContainText("plan equals beta");
    await expect(page.locator(`[data-segment-name='${name}']`)).toContainText(
      "country in list US, CA",
    );
    await captureThemeScreenshots(page, testInfo, "segments-crud-list");

    await page
      .locator(`[data-segment-name='${name}']`)
      .getByRole("button", { name: `Edit ${name}` })
      .click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel("Segment name").fill(`Beta cohort edited ${suffix}`);
    await editDialog.getByRole("button", { name: "Save Segment" }).click();
    await expect(page.locator(`[data-segment-name='Beta cohort edited ${suffix}']`)).toBeVisible();

    await page
      .locator(`[data-segment-name='Beta cohort edited ${suffix}']`)
      .getByRole("button", { name: `Edit Beta cohort edited ${suffix}` })
      .click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog").getByRole("button", { name: "Delete Segment" }).click();
    await expect(page.locator(`[data-segment-name='Beta cohort edited ${suffix}']`)).toHaveCount(0);

    await page.goto("/acme-labs/checkout-api/dev/segments");
    await waitForHydration(page);
    await page
      .locator("[data-segment-name='Draft-locked cohort']")
      .getByRole("button", { name: "Edit Draft-locked cohort" })
      .click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog").getByRole("button", { name: "Delete Segment" }).click();
    await expect(page.getByText("Segment operation failed")).toBeVisible();
    await expect(page.locator("[data-segment-name='Draft-locked cohort']")).toHaveCount(1);
    await captureThemeScreenshots(page, testInfo, "segments-worker-validation");
  });
});
