import { expect, type Page } from "@playwright/test";
import { expectHydratedShell, scopeHref, uniqueKey } from "./panel-actions";
import type { SmokeConfig } from "./smoke-config";

const STEP_TIMEOUT_MS = 30_000;

/** Creates the Experiment draft against the Flag the golden path just made. */
export async function createExperimentDraft(
  page: Page,
  config: SmokeConfig,
  appSlug: string,
  flagKey: string,
): Promise<void> {
  const experimentKey = uniqueKey(config, "panel-smoke-experiment");

  await page.goto(`${scopeHref(config, appSlug)}/experiments/new`, {
    waitUntil: "domcontentloaded",
  });
  await expectHydratedShell(page, appSlug);

  await page.locator("#experiment-name").fill(experimentKey);
  await page.locator("#experiment-key").fill(experimentKey);
  await page.locator("#experiment-flag").click();
  await page.getByRole("option", { name: flagKey }).click();
  await page.getByRole("button", { name: "Create draft" }).click();

  await page.waitForURL(/\/draft(\?|$)/, { timeout: STEP_TIMEOUT_MS });
}

/** Walks measurement and decision, then opens Run 1 through the Start confirmation. */
export async function startRunOne(page: Page, appSlug: string, metricName: string): Promise<void> {
  await page
    .getByRole("group", { name: "Goal Metrics", exact: true })
    .getByLabel(metricName)
    .check();
  await page.locator("#draft-conversion-window").fill("48");
  await saveAndContinue(page, "decision");

  await page.locator("#draft-confidence-level").fill("0.95");
  await saveAndContinue(page, "run");

  // Allocation must total exactly 100, or Start stays disabled with no server call.
  await page.locator("#run-one-allocation-control").fill("50");
  await page.locator("#run-one-allocation-treatment").fill("50");
  await page.locator("#run-one-reason").fill("shared-preview panel golden path");

  const review = page.getByTestId("review-start-run");
  await expect(review, startBlockedReason(page)).toBeEnabled({ timeout: STEP_TIMEOUT_MS });
  await review.click();
  await page.getByRole("button", { name: "Start Run 1" }).click();

  await expect(page.getByTestId("run-start-error")).toHaveCount(0);
  await page.waitForURL(/\/setup$/, { timeout: STEP_TIMEOUT_MS });
  await expectHydratedShell(page, appSlug);
}

/**
 * A Run started seconds ago has no Exposures, so Results correctly renders its waiting
 * state. Either that or the full read-out proves the screen resolved; anything else means
 * Results failed to render at all.
 */
export async function expectResultsRendered(page: Page, appSlug: string): Promise<void> {
  await page.goto(page.url().replace(/\/setup$/, "/results"), { waitUntil: "domcontentloaded" });
  await expectHydratedShell(page, appSlug);

  const results = page
    .getByTestId("results-waiting")
    .or(page.getByRole("heading", { name: "Lift by Variant" }));
  await expect(
    results.first(),
    `Results rendered neither a waiting state nor a read-out at ${page.url()}`,
  ).toBeVisible({ timeout: STEP_TIMEOUT_MS });
}

/** The wizard advances by search param, so the URL is the only unambiguous signal. */
async function saveAndContinue(page: Page, nextStep: string): Promise<void> {
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(new RegExp(`step=${nextStep}`), { timeout: STEP_TIMEOUT_MS }).catch(() => {
    throw new Error(
      `the draft wizard never advanced to the ${nextStep} step (still at ${page.url()}); the save was rejected`,
    );
  });
}

function startBlockedReason(page: Page): string {
  return `Start stayed disabled on the Run step at ${page.url()}; the draft is missing a goal Metric or has an invalid allocation`;
}
