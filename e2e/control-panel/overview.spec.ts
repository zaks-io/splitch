import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_OVERVIEW_STATES,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";
const states = LOCAL_E2E_OVERVIEW_STATES;

function overviewHref(environmentKey: string): string {
  return `/acme-labs/checkout-api/${environmentKey}`;
}

test.describe("App Overview", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("states an unreadable Experiment section instead of rendering it calm", async ({
    page,
  }, testInfo) => {
    // The local fleet cannot serve Analysis: control-plane-api reaches
    // splitch-analysis-api over a NAMED-entrypoint service binding
    // (`#ControlPlaneEntrypoint`), and across two `wrangler dev` processes the
    // dev registry delivers to the default export, so the read comes back 401.
    // That makes the degraded path the honest thing this fleet can prove, and it
    // is the path ADR-0036 is about.
    await page.goto(overviewHref(states.experimentsUnavailable.environmentKey));

    await expect(page.locator("[data-overview='ready']")).toBeVisible();
    await expect(page.locator("[data-overview-state='calm']")).toHaveCount(0);

    for (const card of ["decision", "failure"]) {
      const unavailable = page.locator(
        `[data-overview-card='${card}'] [data-overview-state='unavailable']`,
      );
      await expect(unavailable).toHaveAttribute("data-overview-reason", "analysis_unavailable");
      await expect(unavailable).toContainText("Experiment attention is unknown");
      await expect(unavailable).toContainText("not a clean bill of health");
      // A retryable refusal is the only one allowed to offer a retry.
      await expect(unavailable.getByRole("button", { name: "Retry" })).toBeVisible();
    }

    // An Analysis outage must not blank the sections that do not depend on it.
    await expect(page.locator("[data-overview-card='flag-changes']")).toBeVisible();
    await expect(
      page.locator("[data-overview-card='environment'] [data-overview-policy='enabledState']"),
    ).toContainText("Allow");

    await captureThemeScreenshots(page, testInfo, "app-overview-experiments-unavailable");
  });

  test("lists Flag Configuration changed inside the window and excludes older ones", async ({
    page,
  }, testInfo) => {
    await page.goto(overviewHref(states.flagChanges.environmentKey));

    const card = page.locator("[data-overview-card='flag-changes']");
    await expect(
      card.locator(`[data-overview-flag='${states.flagChanges.recentFlagKey}']`),
    ).toHaveAttribute(
      "href",
      `${overviewHref(states.flagChanges.environmentKey)}/flags/${states.flagChanges.recentFlagKey}`,
    );
    await expect(
      card.locator(`[data-overview-flag='${states.flagChanges.staleFlagKey}']`),
    ).toHaveCount(0);
    // No audit trail exists yet (SPL-161); the card says so rather than guessing.
    await expect(card).toContainText("Who made each change is not recorded yet");

    // This Environment has no running Experiment, so the Experiment sections were
    // read successfully and are empty — which is a different answer from the
    // unavailable state above, and must read differently.
    await expect(page.locator("[data-overview-state='unavailable']")).toHaveCount(0);
    await expect(page.locator("[data-overview-card='decision']")).toContainText(
      "No Experiment is waiting on a decision.",
    );
    await expect(page.locator("[data-overview-card='failure']")).toContainText(
      "No running Experiment is failing.",
    );
    // Recent Flag activity is attention, so the calm state must not claim the page.
    await expect(page.locator("[data-overview-state='calm']")).toHaveCount(0);
    await expect(
      page.locator("[data-overview-card='environment'] [data-overview-policy='enabledState']"),
    ).toContainText("Confirm");

    await captureThemeScreenshots(page, testInfo, "app-overview-flag-changes");
  });

  test("renders the calm empty state only when every section was read and is empty", async ({
    page,
  }, testInfo) => {
    await page.goto(overviewHref(states.calm.environmentKey));

    await expect(page.locator("[data-overview-state='calm']")).toContainText(
      "Nothing needs your attention",
    );
    await expect(page.locator("[data-overview-state='unavailable']")).toHaveCount(0);
    // The Environment card is policy posture, not attention, so it survives calm.
    await expect(page.locator("[data-overview-card='environment']")).toBeVisible();
    await expect(page.locator("[data-overview-card='decision']")).toHaveCount(0);

    await captureThemeScreenshots(page, testInfo, "app-overview-calm");
  });

  test("refuses a scope the signed-in principal does not hold", async ({ page }) => {
    // agent-console belongs to orbit-tools; asking for it under acme-labs is a
    // cross-scope read, and the Panel must not answer it from the session claim.
    await page.goto("/acme-labs/agent-console/prod");

    await expect(page.getByText("The requested App or Environment was not found.")).toBeVisible();
    await expect(page.locator("[data-overview='ready']")).toHaveCount(0);
  });
});
