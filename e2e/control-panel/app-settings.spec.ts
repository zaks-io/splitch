import { type BrowserContext, expect, test } from "@playwright/test";
import { LOCAL_E2E_SETTINGS_APP_SLUGS } from "../../scripts/local-e2e-app-settings-fixture.mjs";
import {
  LOCAL_E2E_MEMBER_PROFILES,
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";
const ownerEmail = LOCAL_E2E_MEMBER_PROFILES.user_local_e2e;
const memberEmail = LOCAL_E2E_MEMBER_PROFILES.user_local_member_e2e;

test.describe("App Settings", () => {
  test("shows an Owner App identity, catalog, access, and the danger zone", async ({
    context,
    page,
  }, testInfo) => {
    await signIn(context, LOCAL_E2E_SESSION_TOKEN);
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto("/acme-labs/checkout-api/prod/settings");
    await waitForHydration(page);

    // The section is split App / Environment, and App is where /settings lands.
    await expect(page.locator("[data-settings-tab='app']")).toHaveAttribute("aria-current", "page");
    await expect(page.locator("[data-settings-tab='environment']")).not.toHaveAttribute(
      "aria-current",
      "page",
    );

    await expect(page.getByLabel("App name")).toHaveValue("Checkout API");
    await expect(page.getByLabel("URL slug")).toHaveValue("checkout-api");

    // Variant catalog: App-level, read-only, values as written.
    const catalogRow = page.locator("[data-app-catalog-flag='new-checkout']");
    await expect(catalogRow).toContainText("New Checkout");
    await expect(catalogRow).toContainText("control");
    await expect(catalogRow).toContainText("treatment");
    await expect(page.getByTestId("flag-default-unresolved")).toHaveCount(0);

    // App access, which is a different list from Organization membership.
    await expect(page.locator("[data-app-member='user_local_e2e']")).toContainText(ownerEmail);
    await expect(page.locator("[data-app-member='user_local_member_e2e']")).toContainText(
      memberEmail,
    );

    await expect(page.getByTestId("app-danger-zone")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "app-settings-owner");

    // The Environment half is a different tab, not this screen.
    await expect(page.getByText("Provision API Key")).toHaveCount(0);
    await page.locator("[data-settings-tab='environment']").click();
    await expect(page.getByRole("button", { name: "Provision API Key" })).toBeVisible();
  });

  test("gives a Member the same facts read-only, with no App-level write offered", async ({
    context,
    page,
  }, testInfo) => {
    await signIn(context, LOCAL_E2E_MEMBER_SESSION_TOKEN);
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto("/acme-labs/checkout-api/prod/settings");
    await waitForHydration(page);

    const readOnly = page.getByTestId("app-identity-read-only");
    await expect(readOnly).toContainText("Checkout API");
    await expect(readOnly).toContainText("checkout-api");
    await expect(page.getByLabel("App name")).toHaveCount(0);

    // A Member sees who has access, but is offered no way to change it.
    await expect(page.locator("[data-app-member='user_local_e2e']")).toContainText(ownerEmail);
    await expect(page.getByTestId("app-grant-not-permitted")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revoke access" })).toHaveCount(0);
    await expect(page.getByLabel("App role")).toHaveCount(0);
    await expect(page.getByTestId("app-danger-zone")).toHaveCount(0);
    await captureThemeScreenshots(page, testInfo, "app-settings-member");
  });

  test("grants, re-roles, and revokes App access as an Owner", async ({ context, page }, info) => {
    const appSlug = settingsApp(info.retry);
    await signIn(context, LOCAL_E2E_SESSION_TOKEN);
    await page.goto(`/acme-labs/${appSlug}/prod/settings`);
    await waitForHydration(page);

    const memberRow = page.locator("[data-app-member='user_local_member_e2e']");
    await expect(memberRow).toHaveCount(0);

    await page.getByLabel("Grant access to").click();
    await page.getByRole("option", { name: memberEmail }).click();
    await page.getByLabel("Role", { exact: true }).click();
    await page.getByRole("option", { name: "Admin" }).click();
    await page.getByRole("button", { name: "Grant access" }).click();

    await expect(memberRow).toContainText(memberEmail);
    await expect(memberRow.getByLabel("App role")).toContainText("Admin");

    await memberRow.getByLabel("App role").click();
    await page.getByRole("option", { name: "Member" }).click();
    await expect(memberRow.getByLabel("App role")).toContainText("Member");

    // Survives a reload: the grant is in D1, not in this page's state.
    await page.reload();
    await waitForHydration(page);
    await expect(memberRow.getByLabel("App role")).toContainText("Member");

    page.once("dialog", (dialog) => dialog.accept());
    await memberRow.getByRole("button", { name: "Revoke access" }).click();
    await expect(memberRow).toHaveCount(0);
    await page.reload();
    await waitForHydration(page);
    await expect(page.locator("[data-app-member='user_local_member_e2e']")).toHaveCount(0);
  });

  test("renames an App, then destroys it only after the consequences are typed", async ({
    context,
    page,
  }, info) => {
    const appSlug = settingsApp(info.retry);
    const renamedSlug = `${appSlug}-renamed`;
    await signIn(context, LOCAL_E2E_SESSION_TOKEN);
    await page.setViewportSize({ width: 1280, height: 1100 });
    await page.goto(`/acme-labs/${appSlug}/prod/settings`);
    await waitForHydration(page);

    await page.getByLabel("App name").fill("Settings Lab Renamed");
    await page.getByLabel("URL slug").fill(renamedSlug);
    await page.getByRole("button", { name: "Save App details" }).click();

    // A slug change moves the App's URL, and the Panel follows it rather than
    // leaving the operator on a path that no longer resolves.
    await page.waitForURL(`**/acme-labs/${renamedSlug}/prod/settings`);
    await waitForHydration(page);
    await expect(page.getByRole("heading", { name: "Settings Lab Renamed" })).toBeVisible();
    await expect(page.getByLabel("URL slug")).toHaveValue(renamedSlug);

    await page.getByTestId("app-delete-open").click();

    // The dry run names what goes, in full, before anything is destroyed.
    const consequences = page.getByTestId("app-delete-consequences");
    await expect(consequences).toContainText("1 Environment");
    await expect(consequences).toContainText("Production");
    await expect(consequences).toContainText("Flag");
    await expect(consequences).toContainText(`flag_${appSlug.replaceAll("-", "_")}_e2e`);

    const submit = page.getByTestId("app-delete-submit");
    await expect(submit).toContainText("Settings Lab Renamed");
    await expect(submit).toBeDisabled();

    // Close is not close enough: only the exact slug arms the destruction.
    await page.getByTestId("app-delete-confirm").fill("Settings Lab Renamed");
    await expect(submit).toBeDisabled();
    await page.getByTestId("app-delete-confirm").fill(renamedSlug.toUpperCase());
    await expect(submit).toBeDisabled();
    await page.getByTestId("app-delete-confirm").fill(`${renamedSlug} `);
    await expect(submit).toBeDisabled();
    await captureThemeScreenshots(page, info, "app-settings-danger-zone");

    await page.getByTestId("app-delete-confirm").fill(renamedSlug);
    await expect(submit).toBeEnabled();
    await submit.click();

    await page.waitForURL(`${origin}/`);
    await expect(page.getByRole("link", { name: "Settings Lab Renamed" })).toHaveCount(0);
  });
});

function settingsApp(retry: number): string {
  const slug =
    LOCAL_E2E_SETTINGS_APP_SLUGS[Math.min(retry, LOCAL_E2E_SETTINGS_APP_SLUGS.length - 1)];
  if (!slug) throw new Error(`no App Settings fixture App for attempt ${retry}`);
  return slug;
}

async function signIn(context: BrowserContext, token: string) {
  await context.addCookies([{ name: "__session", value: token, url: origin }]);
}
