import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("App-level Metrics", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("shows the same App-level definitions from every Environment", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/dev/metrics");

    await expect(page.getByRole("heading", { name: "Metrics (App-level)" })).toBeVisible();
    await expect(page.getByText("Defined once, available in every Environment")).toBeVisible();
    await expect(page.getByText(/Choose a Metric's role per Experiment/)).toBeVisible();
    await expect(page.locator("[data-metric-key='checkout-conversion']")).toBeVisible();
    await expect(page.locator("[data-metric-key='checkout-reliability']")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "metrics-app-level");

    await page.goto("/acme-labs/checkout-api/prod/metrics");
    await expect(page.locator("[data-metric-key='checkout-conversion']")).toBeVisible();
    await expect(page.locator("[data-metric-key='checkout-reliability']")).toBeVisible();
  });

  test("generates a code-agent prompt after creating a Ratio Metric", async ({
    page,
  }, testInfo) => {
    const key = `prompt-ratio-${testInfo.retry}`;
    await page.goto("/acme-labs/checkout-api/dev/metrics");
    await waitForHydration(page);

    await page.getByRole("button", { name: "Create Metric" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Metric name").fill("Prompt ratio");
    await dialog.getByLabel("Metric key").fill(key);
    await dialog.getByLabel("Aggregation type").click();
    await page.getByRole("option", { name: "Ratio" }).click();
    await dialog.getByLabel("Numerator Metric").click();
    await page.getByRole("option", { name: "Checkout reliability" }).click();
    await dialog.getByLabel("Denominator Metric").click();
    await page.getByRole("option", { name: "Checkout errors" }).click();
    await dialog.getByRole("button", { name: "Create Metric" }).click();

    const prompt = page.getByTestId("metric-code-agent-prompt-text");
    await expect(prompt).toContainText(`"key": "${key}"`);
    await expect(prompt).toContainText('"eventName": "checkout_succeeded"');
    await expect(prompt).toContainText('"eventName": "checkout_error"');
    await expect(prompt).toContainText("do not send an event for the ratio itself");
    await page
      .getByTestId("metric-code-agent-success")
      .getByRole("button", { name: "Close" })
      .click();
  });

  test("round-trips every aggregation and surfaces Worker validation", async ({
    page,
  }, testInfo) => {
    const suffix = `${testInfo.retry}`;
    const signupsKey = `signups-${suffix}`;
    const countKey = `items-${suffix}`;
    const revenueKey = `revenue-${suffix}`;
    const ratioKey = `signup-rate-${suffix}`;

    await page.goto("/acme-labs/billing-api/prod/metrics");
    await waitForHydration(page);
    for (const key of [signupsKey, countKey, revenueKey, ratioKey]) {
      await expect(page.locator(`[data-metric-key='${key}']`)).toHaveCount(0);
    }

    await createMetric(page, {
      name: `Signups ${suffix}`,
      key: signupsKey,
      eventDefinitionId: "signed_up",
      kind: "Binomial",
    });
    await createMetric(page, {
      name: `Order items ${suffix}`,
      key: countKey,
      eventDefinitionId: "order_completed",
      kind: "Count",
      valueField: "quantity",
    });
    await createMetric(page, {
      name: `Revenue ${suffix}`,
      key: revenueKey,
      eventDefinitionId: "purchase_completed",
      kind: "Revenue",
      valueField: "amount",
    });
    await createMetric(page, {
      name: `Signup rate ${suffix}`,
      key: ratioKey,
      kind: "Ratio",
      numerator: `Signups ${suffix}`,
      denominator: `Order items ${suffix}`,
    });

    for (const [key, kind] of [
      [signupsKey, "Binomial"],
      [countKey, "Count"],
      [revenueKey, "Revenue"],
      [ratioKey, "Ratio"],
    ] as const) {
      await expect(page.locator(`[data-metric-key='${key}']`)).toContainText(kind);
    }
    await expect(page.locator(`[data-metric-key='${ratioKey}']`)).toContainText(
      `Signups ${suffix} / Order items ${suffix}`,
    );
    await captureThemeScreenshots(page, testInfo, "metrics-crud-list");

    const countRow = page.locator(`[data-metric-key='${countKey}']`);
    await countRow.getByRole("button", { name: `Edit Order items ${suffix}` }).click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByLabel("Aggregation type")).toBeDisabled();
    await editDialog.getByLabel("Metric name").fill(`Completed items ${suffix}`);
    await editDialog.getByRole("button", { name: "Save Metric" }).click();
    await expect(page.locator(`[data-metric-key='${countKey}']`)).toContainText(
      `Completed items ${suffix}`,
    );

    await page
      .locator(`[data-metric-key='${revenueKey}']`)
      .getByRole("button", { name: `Edit Revenue ${suffix}` })
      .click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("dialog").getByRole("button", { name: "Delete Metric" }).click();
    await expect(page.locator(`[data-metric-key='${revenueKey}']`)).toHaveCount(0);

    await page.getByRole("button", { name: "Create Metric" }).click();
    const duplicateDialog = page.getByRole("dialog");
    await expect(duplicateDialog.getByLabel(/^Role$/i)).toHaveCount(0);
    await duplicateDialog.getByLabel("Metric name").fill("Duplicate signup");
    await duplicateDialog.getByLabel("Metric key").fill(signupsKey);
    await duplicateDialog.getByLabel("Event name").fill("signed_up_again");
    await duplicateDialog.getByRole("button", { name: "Create Metric" }).click();
    await expect(duplicateDialog.getByText("Metric key already exists")).toBeVisible();
    await expect(duplicateDialog.getByText("Metric operation failed")).toBeVisible();
    await expect(page.locator(`[data-metric-key='${signupsKey}']`)).toHaveCount(1);
    await captureThemeScreenshots(page, testInfo, "metrics-worker-validation");
  });
});

type MetricFormInput = {
  name: string;
  key: string;
  kind: "Binomial" | "Count" | "Revenue" | "Ratio";
  /** Non-Ratio kinds only: a Ratio binds two Metrics, not an Event Definition. */
  eventDefinitionId?: string;
  valueField?: string;
  numerator?: string;
  denominator?: string;
};

async function createMetric(page: import("@playwright/test").Page, input: MetricFormInput) {
  await page.getByRole("button", { name: "Create Metric" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Metric name").fill(input.name);
  await dialog.getByLabel("Metric key").fill(input.key);
  if (input.kind !== "Binomial") {
    await dialog.getByLabel("Aggregation type").click();
    await page.getByRole("option", { name: input.kind }).click();
  }
  if (input.eventDefinitionId) {
    await dialog.getByLabel("Event name").fill(input.eventDefinitionId);
  }
  if (input.valueField) await dialog.getByLabel("Event value field").fill(input.valueField);
  if (input.numerator) {
    await dialog.getByLabel("Numerator Metric").click();
    await page.getByRole("option", { name: input.numerator }).click();
  }
  if (input.denominator) {
    await dialog.getByLabel("Denominator Metric").click();
    await page.getByRole("option", { name: input.denominator }).click();
  }
  await dialog.getByRole("button", { name: "Create Metric" }).click();
  await expect(page.locator(`[data-metric-key='${input.key}']`)).toBeVisible();
  const success = page.getByTestId("metric-code-agent-success");
  await expect(success).toBeVisible();
  await success.getByRole("button", { name: "Close" }).click();
}
