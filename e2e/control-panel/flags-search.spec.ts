import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";

test("loads the Flags matrix with unrelated search parameters", async ({ context, page }) => {
  await context.addCookies([
    { name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: "http://127.0.0.1:18793" },
  ]);

  const response = await page.goto("/acme-labs/checkout-api?path=/flags&created=new-checkout");

  expect(response?.status()).toBe(200);
  await waitForHydration(page);
  await expect(page.locator("[data-app-shell='ready']")).toBeVisible();
  await expect(page.getByRole("heading", { name: "checkout-api", exact: true })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("new-checkout");
  await expect(page.getByText("Flags unavailable", { exact: true })).toHaveCount(0);
});
