import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("per-Environment Settings", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("keeps credentials show-once and round-trips Worker Policy truth", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto("/acme-labs/checkout-api/dev/settings");

    await expect(page.getByRole("heading", { name: "Development" })).toBeVisible();
    await verifyInitialSettingsState(page, testInfo);
    await expect(page.getByLabel("Variant availability: Approve coming soon")).toBeDisabled();
    const killSwitch = page.getByTestId("kill-switch-policy");
    await expect(killSwitch).toContainText("Never gated");
    await expect(killSwitch.locator("input")).toHaveCount(0);

    const lockButton = page.getByRole("button", { name: "Lock to origins" });
    if (await lockButton.isVisible().catch(() => false)) {
      await page.getByLabel("Allowed origins").fill("https://app.example.com");
      await lockButton.click();
    }
    await expect(page.getByText("Locked origins")).toBeVisible();
    await expect(page.getByText("https://app.example.com", { exact: true })).toBeVisible();

    const beforeIds = await apiKeyIds(page);
    await page.getByRole("button", { name: "Provision API Key" }).click();
    const onceOnly = page.getByTestId("once-only-api-key");
    await expect(onceOnly).toBeVisible();
    const secret = (await onceOnly.textContent())?.trim();
    expect(secret).toMatch(/^sk_/u);

    await expect.poll(async () => (await apiKeyIds(page)).length).toBe(beforeIds.length + 1);
    const newKeyId = (await apiKeyIds(page)).find((keyId) => !beforeIds.includes(keyId));
    expect(newKeyId).toBeTruthy();
    if (!secret || !newKeyId) throw new Error("provisioned API Key was not visible once");

    await page.getByRole("button", { name: "I saved it" }).click();
    await expect(onceOnly).toHaveCount(0);

    const postCreationBodies: Array<Promise<string>> = [];
    page.on("response", (response) => {
      if (response.url().startsWith(origin)) {
        postCreationBodies.push(response.text().catch(() => ""));
      }
    });
    await page.reload();
    await expect(page.locator(`[data-api-key-id='${newKeyId}']`)).toContainText("Active");
    await expect(page.getByTestId("once-only-api-key")).toHaveCount(0);
    expect((await Promise.all(postCreationBodies)).join("\n")).not.toContain(secret);

    page.once("dialog", (dialog) => dialog.accept());
    await page
      .locator(`[data-api-key-id='${newKeyId}']`)
      .getByRole("button", { name: "Revoke" })
      .click();
    await page.reload();
    const revokedRow = page.locator(`[data-api-key-id='${newKeyId}']`);
    await expect(revokedRow).toContainText("Revoked");
    await expect(revokedRow.getByRole("button", { name: "Revoke" })).toBeDisabled();

    const policyRow = page.locator("fieldset").filter({ hasText: "Variant availability" });
    const nextLevel = testInfo.retry % 2 === 0 ? "confirm" : "allow";
    await policyRow.locator(`input[value='${nextLevel}']`).check();
    await page.getByRole("button", { name: "Save Policy" }).click();
    await expect(page.getByRole("button", { name: "Save Policy" })).toBeDisabled();
    await page.reload();
    await expect(
      page
        .locator("fieldset")
        .filter({ hasText: "Variant availability" })
        .locator(`input[value='${nextLevel}']`),
    ).toBeChecked();
    expect((await Promise.all(postCreationBodies)).join("\n")).not.toContain(secret);

    await page.goto("/acme-labs/checkout-api/prod/settings");
    const prodRows = page.locator("fieldset");
    await expect(prodRows).toHaveCount(4);
    for (const row of await prodRows.all()) {
      await expect(row.locator("input[value='confirm']")).toBeChecked();
    }
    await expect(page.getByTestId("once-only-api-key")).toHaveCount(0);
    await captureThemeScreenshots(page, testInfo, "settings-environment-prod");
  });
});

async function verifyInitialSettingsState(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
): Promise<void> {
  const openWarning = page.getByText("accepts requests from any origin");
  await expect(openWarning.or(page.getByText("Locked origins"))).toBeVisible();
  if (await openWarning.isVisible()) {
    await captureThemeScreenshots(page, testInfo, "settings-environment-open");
  }
}

async function apiKeyIds(page: import("@playwright/test").Page): Promise<string[]> {
  return page.locator("[data-api-key-id]").evaluateAll((rows) =>
    rows.flatMap((row) => {
      const keyId = row.getAttribute("data-api-key-id");
      return keyId ? [keyId] : [];
    }),
  );
}
