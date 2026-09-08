import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";

import { waitForHydration } from "./hydration";

const origin = "http://127.0.0.1:18793";

test("concludes a healthy Run and applies the authored winner configuration", async ({
  page,
  context,
}) => {
  await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  await page.goto(
    "/acme-labs/checkout-api/dev/experiments/experiment_checkout_conclusion_e2e/results",
  );
  await waitForHydration(page);
  const conclude = page.getByRole("button", { name: "Conclude Run", exact: true });
  await expect(conclude).toBeEnabled();
  await conclude.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Conclude Run", exact: true })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Selected Variant", exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: "treatment", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "control", exact: true }).uncheck();
  await expect(dialog.getByRole("checkbox", { name: "treatment", exact: true })).toBeChecked();
  await expect(dialog.getByText("No Targeting Rules in this Environment.")).toBeVisible();
  await changeTargetWhileReviewing(context);
  await dialog.getByRole("button", { name: "Confirm and apply", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Confirm and apply", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Refresh Results", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(conclude).toBeEnabled();
  await conclude.click();
  await dialog.getByRole("combobox", { name: "Selected Variant", exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: "treatment", exact: true }).click();
  await expect(dialog.getByRole("switch", { name: "Flag enabled", exact: true })).not.toBeChecked();
  await dialog.getByRole("switch", { name: "Flag enabled", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "control", exact: true }).uncheck();
  const attempts = await loseFirstConclusionResponse(page);
  await dialog.getByRole("button", { name: "Confirm and apply", exact: true }).click();
  await expect(dialog.getByText(/The conclusion status could not be confirmed/)).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Selected Variant", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Retry conclusion", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Run concluded. Promotion applied.");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(conclude).toBeDisabled();
  await expect(page.getByText("This Run has ended.", { exact: true })).toBeVisible();

  await page.goto("/acme-labs/checkout-api/dev/flags/checkout-conclusion");
  await expect(
    page.getByRole("heading", { name: "Checkout Conclusion", exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-availability-input="control"]')).not.toBeChecked();
  await expect(page.locator('[data-availability-input="treatment"]')).toBeChecked();
});

async function loseFirstConclusionResponse(page: Page) {
  const attempts: string[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const body = request.postData();
    if (request.method() !== "POST" || !body?.includes("expectedResultToken")) {
      await route.continue();
      return;
    }
    attempts.push(body);
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("connectionclosed");
    } else {
      await route.continue();
    }
  });
  return attempts;
}

async function changeTargetWhileReviewing(context: BrowserContext) {
  const other = await context.newPage();
  try {
    await other.goto("/acme-labs/checkout-api/dev/flags/checkout-conclusion");
    await waitForHydration(other);
    const enabled = other.locator('[data-kill-switch-input="true"]');
    await expect(enabled).toBeChecked();
    await enabled.click();
    await expect(other.locator("[data-kill-switch-state]")).toHaveAttribute(
      "data-kill-switch-state",
      "disabled",
    );
  } finally {
    await other.close();
  }
}
