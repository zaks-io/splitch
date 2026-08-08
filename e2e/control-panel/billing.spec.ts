import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("Billing & Usage", () => {
  test("an owner reaches Billing from the Org shell and sees the month stated", async ({
    context,
    page,
  }, testInfo) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
    await page.goto("/acme-labs");
    await page.getByRole("link", { name: "Billing & Usage" }).click();
    await expect(page).toHaveURL("/acme-labs/billing");

    // The month is either counted or refused; it is never a blank that reads as
    // a zero month (ADR-0036).
    const usage = page.locator("[data-usage-state]");
    await expect(usage).toBeVisible();
    await expect(usage).toHaveAttribute("data-usage-state", /^(zero|populated|unavailable)$/);

    // Quota enforcement is deferred, so the panel states that instead of
    // claiming an ADR-0033 runtime state it cannot observe.
    await expect(page.locator("[data-quota-state='deferred']")).toContainText(
      "No limit is enforced",
    );
    await expect(page.locator("[data-payment-state='stubbed']")).toContainText(
      "no payment method or invoice to show",
    );

    await captureThemeScreenshots(page, testInfo, "org-billing");
  });

  test("an owner sees the plan action present but unwired; a member sees it locked", async ({
    browser,
    context,
    page,
  }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
    await page.goto("/acme-labs/billing");
    const ownerAction = page.getByTestId("manage-plan");
    await expect(ownerAction).toBeVisible();
    await expect(ownerAction).toBeDisabled();
    await expect(page.getByTestId("manage-plan-locked")).toHaveCount(0);

    // A manually created context does not inherit the project's `use` options.
    const memberContext = await browser.newContext({ baseURL: origin });
    await memberContext.addCookies([
      { name: "__session", value: LOCAL_E2E_MEMBER_SESSION_TOKEN, url: origin },
    ]);
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/acme-labs/billing");

    // Usage is read-only for a member, so the screen itself is theirs to read.
    await expect(memberPage.locator("[data-usage-state]")).toBeVisible();
    await expect(memberPage.getByTestId("manage-plan")).toHaveCount(0);
    const locked = memberPage.getByTestId("manage-plan-locked");
    await expect(locked).toBeVisible();
    await expect(locked).toBeDisabled();

    await memberContext.close();
  });

  test("a non-member is refused the Organization's usage", async ({ browser }) => {
    const memberContext = await browser.newContext({ baseURL: origin });
    await memberContext.addCookies([
      { name: "__session", value: LOCAL_E2E_MEMBER_SESSION_TOKEN, url: origin },
    ]);
    const memberPage = await memberContext.newPage();
    // The member fixture belongs to acme-labs only, so orbit-tools is another
    // tenant's Organization.
    await memberPage.goto("/orbit-tools/billing");

    await expect(memberPage.getByText("Access denied")).toBeVisible();
    await expect(memberPage.locator("[data-usage-state]")).toHaveCount(0);

    await memberContext.close();
  });
});
