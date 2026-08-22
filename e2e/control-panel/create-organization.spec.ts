import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_NEWCOMER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

/**
 * Distinct seed values per case, deliberately. Identical fixtures have twice
 * masked bugs where one case only passed because another case had already put
 * the state it needed in place, so the newcomer case creates a handle nobody
 * else touches and the collision case collides with the seeded `acme-labs`
 * rather than with whatever the previous test happened to leave behind.
 */
const newcomerSlug = `e2e-newcomer-org-${Date.now().toString(36)}`;
const correctedSlug = `e2e-corrected-org-${Date.now().toString(36)}`;

test.describe("Create Organization", () => {
  test("a User with zero memberships creates an Organization and lands on Home", async ({
    context,
    page,
  }, testInfo) => {
    await context.addCookies([
      { name: "__session", value: LOCAL_E2E_NEWCOMER_SESSION_TOKEN, url: origin },
    ]);
    await page.goto("/");
    await waitForHydration(page);

    // The landing screen a brand new User actually sees. Before SPL-205 this was
    // a dead end: signed in, no Organization, no way to make one.
    const chooser = page.locator("[data-org-chooser='ready']");
    await expect(chooser).toContainText("Create your first Organization");
    // It teaches the model rather than just offering a button.
    await expect(chooser).toContainText("outermost boundary in splitch");
    await expect(page.getByTestId("create-organization")).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "create-organization-empty-state");

    await page.getByTestId("create-organization").click();
    await page.getByLabel("Organization name").fill("Newcomer Labs");
    await page.getByTestId("create-organization-slug").fill(newcomerSlug);
    await captureThemeScreenshots(page, testInfo, "create-organization-form");
    await page.getByTestId("create-organization-submit").click();

    // Landing in Home is the whole point: the Organization is real, the
    // session knows about it, and the next thing to make is an App.
    await expect(page).toHaveURL(`/${newcomerSlug}`);
    await expect(page.locator("[data-org-shell='ready']")).toHaveAttribute(
      "data-org",
      newcomerSlug,
    );
    await captureThemeScreenshots(page, testInfo, "create-organization-landed");

    // The membership snapshot really was refreshed, not just navigated past.
    await page.goto("/");
    await expect(page).toHaveURL(`/${newcomerSlug}`);
    await expect(page.locator("[data-org-shell='ready']")).toHaveAttribute(
      "data-org",
      newcomerSlug,
    );
  });

  test("a taken handle is refused in the Worker's words, and the User can correct it", async ({
    context,
    page,
  }, testInfo) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
    // An existing member lands on an Organization Home; Create Organization
    // lives in the sidebar there.
    await page.goto("/");
    await waitForHydration(page);

    await page.getByTestId("create-organization").click();
    await page.getByLabel("Organization name").fill("Acme Labs Again");
    await page.getByTestId("create-organization-slug").fill("acme-labs");
    await page.getByTestId("create-organization-submit").click();

    // The Worker's typed refusal, verbatim. Nothing auto-suffixes the handle the
    // User typed, so the collision stays visible and correctable (ADR-0036).
    const error = page.getByTestId("create-organization-error");
    await expect(error).toContainText('URL handle "acme-labs" is already taken');
    await expect(error).toContainText("Pick a different one");
    await expect(page.getByTestId("create-organization-slug")).toHaveValue("acme-labs");
    await captureThemeScreenshots(page, testInfo, "create-organization-slug-conflict");

    // The offered next step is one that can actually succeed.
    await page.getByTestId("create-organization-slug").fill(correctedSlug);
    await page.getByTestId("create-organization-submit").click();

    await expect(page).toHaveURL(`/${correctedSlug}`);
    await expect(page.locator("[data-org-shell='ready']")).toHaveAttribute(
      "data-org",
      correctedSlug,
    );
  });
});
