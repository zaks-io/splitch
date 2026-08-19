import { expect, type Page } from "@playwright/test";
import type { SmokeConfig } from "./smoke-config";

/**
 * Must stay in `TRANSIENT_APP_KEY_PREFIXES` (scripts/seed-shared-preview-smoke-sql.mjs).
 * Cleanup deletes by prefix, so an App created outside one orphans the shared preview.
 */
const PANEL_APP_KEY_PREFIX = "panel-smoke-app";

const HYDRATION_TIMEOUT_MS = 30_000;

export function uniqueKey(config: SmokeConfig, prefix: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${config.runId}-${suffix}`.toLowerCase();
}

export function scopeHref(config: SmokeConfig, appSlug: string): string {
  return `${config.panelBaseUrl}/${config.smokeOrgSlug}/${appSlug}/dev`;
}

/** Creates the transient App the rest of the golden path lives inside. */
export async function createApp(page: Page, config: SmokeConfig): Promise<string> {
  const appSlug = uniqueKey(config, PANEL_APP_KEY_PREFIX);

  await page.goto(`${config.panelBaseUrl}/${config.smokeOrgSlug}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.locator("[data-org-shell='ready']"),
    `Organization shell never became ready for ${config.smokeOrgSlug}`,
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });

  await page.getByTestId("create-app").click();
  await page.getByLabel("App name").fill(appSlug);
  await page.getByLabel("URL slug").fill(appSlug);
  await page.locator("form").getByRole("button", { name: "Create App" }).click();

  const card = page.locator(`[data-app-card='${appSlug}']`);
  await expect(card, `created App ${appSlug} never appeared in the Organization shell`).toBeVisible(
    {
      timeout: HYDRATION_TIMEOUT_MS,
    },
  );
  return appSlug;
}

/** Opens the App at its dev Environment and waits for a hydrated shell. */
export async function openApp(page: Page, config: SmokeConfig, appSlug: string): Promise<void> {
  await page.goto(scopeHref(config, appSlug), { waitUntil: "domcontentloaded" });
  await expectHydratedShell(page, appSlug);
}

export async function expectHydratedShell(page: Page, appSlug: string): Promise<void> {
  const shell = page.locator("[data-app-shell='ready']");
  await expect(shell, `App shell never became ready for ${appSlug}`).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  await expect(shell, `App shell never hydrated for ${appSlug}`).toHaveAttribute(
    "data-hydrated",
    "true",
    { timeout: HYDRATION_TIMEOUT_MS },
  );
}

/** Creates a boolean Flag with a control and a treatment Variant. */
export async function createFlag(
  page: Page,
  config: SmokeConfig,
  appSlug: string,
): Promise<string> {
  const flagKey = uniqueKey(config, "panel-smoke-flag");

  await page.goto(`${scopeHref(config, appSlug)}/flags`, { waitUntil: "domcontentloaded" });
  await expectHydratedShell(page, appSlug);
  await page.getByRole("button", { name: "Create Flag" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Flag key").fill(flagKey);
  const catalog = dialog.getByTestId("variant-catalog");
  await catalog.locator("#variant-name-0").fill("control");
  await catalog.locator("#variant-name-1").fill("treatment");
  await dialog.getByRole("button", { name: "Create Flag" }).click();

  await expect(
    dialog.getByRole("heading", { name: "Connect your code" }),
    `Flag ${flagKey} was never confirmed as created`,
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  await dialog
    .locator("[data-slot='dialog-footer']")
    .getByRole("button", { name: "Close" })
    .click();

  await expect(page.locator(`[data-flag-key='${flagKey}']`)).toBeVisible({
    timeout: HYDRATION_TIMEOUT_MS,
  });
  return flagKey;
}

/**
 * Flips the Flag's kill switch in the dev Environment, which is Allow-policy, so the
 * write must apply straight through with no approval gate.
 */
export async function editFlag(
  page: Page,
  config: SmokeConfig,
  appSlug: string,
  flagKey: string,
): Promise<void> {
  await page.goto(`${scopeHref(config, appSlug)}/flags/${flagKey}`, {
    waitUntil: "domcontentloaded",
  });
  await expectHydratedShell(page, appSlug);

  const state = page.locator("[data-kill-switch-state]");
  // A null read means the attribute is absent, and `not.toHaveAttribute(..., "")` would
  // then pass against nothing. Fail here instead of asserting a change that cannot happen.
  const before = await state.getAttribute("data-kill-switch-state");
  if (before === null) {
    throw new Error(
      `Flag ${flagKey} rendered no data-kill-switch-state attribute, so the kill-switch ` +
        "assertion has nothing to compare against",
    );
  }
  await page.locator("[data-kill-switch-input='true']").click();

  await expect(
    page.locator("[data-gated-write-applied='ungated']"),
    "dev is an Allow-policy Environment, so the kill-switch write must apply ungated",
  ).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  await expect(page.locator("[data-approval-gate]")).toHaveCount(0);
  await expect(
    state,
    "kill-switch state never changed after the write applied",
  ).not.toHaveAttribute("data-kill-switch-state", before, { timeout: HYDRATION_TIMEOUT_MS });
}

/**
 * An Experiment draft cannot reach its measurement step without a Metric on the App, and
 * a freshly created App has none.
 */
export async function createMetric(
  page: Page,
  config: SmokeConfig,
  appSlug: string,
): Promise<string> {
  const metricKey = uniqueKey(config, "panel-smoke-metric");

  await page.goto(`${scopeHref(config, appSlug)}/metrics`, { waitUntil: "domcontentloaded" });
  await expectHydratedShell(page, appSlug);
  await page.getByRole("button", { name: "Create Metric" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Metric name").fill(metricKey);
  await dialog.getByLabel("Metric key").fill(metricKey);
  await dialog.getByLabel("Event name").fill("panel_smoke_converted");
  await dialog.getByRole("button", { name: "Create Metric" }).click();

  await expect(
    page.getByRole("dialog"),
    `Metric ${metricKey} dialog never closed, so the write did not land`,
  ).toHaveCount(0, { timeout: HYDRATION_TIMEOUT_MS });
  await expect(page.getByText(metricKey).first()).toBeVisible({ timeout: HYDRATION_TIMEOUT_MS });
  return metricKey;
}
