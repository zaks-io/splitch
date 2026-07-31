import { type BrowserContext, expect, type Page } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { LOCAL_E2E_FLAG_EDITING } from "../../scripts/local-e2e-flag-editing-fixture.mjs";

/**
 * The gestures and assertions the Flag-editing specs share (SPL-118).
 *
 * They are here rather than duplicated per spec so that "what an ungated write
 * looks like" and "what a gated write leaves behind" have exactly one definition:
 * two copies would let one spec quietly relax while the other keeps passing.
 */

const origin = "http://127.0.0.1:18793";

export const allowEnv = LOCAL_E2E_FLAG_EDITING.allowEnvironmentKey;
export const confirmEnv = LOCAL_E2E_FLAG_EDITING.confirmEnvironmentKey;
export const editingFlags = LOCAL_E2E_FLAG_EDITING.flags;

export async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
}

export async function openFlag(page: Page, environmentKey: string, flagKey: string): Promise<void> {
  await page.goto(
    `/acme-labs/${LOCAL_E2E_FLAG_EDITING.appSlug}/${environmentKey}/flags/${flagKey}`,
  );
  await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
  await expect(page.locator(`[data-flag-env-config='${environmentKey}']`)).toBeVisible();
}

export function killSwitch(page: Page) {
  return page.locator("[data-kill-switch-input='true']");
}

export function approvalGate(page: Page) {
  return page.locator("[data-approval-gate]");
}

export async function killSwitchState(page: Page): Promise<string | null> {
  return page.locator("[data-kill-switch-state]").getAttribute("data-kill-switch-state");
}

export async function addRule(
  page: Page,
  attribute: string,
  value: string,
  variantName: string,
): Promise<void> {
  await page.locator("[data-targeting-attribute='true']").fill(attribute);
  await page.locator("[data-targeting-value='true']").fill(value);
  await page.locator("[data-targeting-variant='true']").selectOption({ label: variantName });
  await page.locator("[data-targeting-add='true']").click();
}

/** An ungated write says so outright, and no gate may have appeared on the way. */
export async function expectUngated(page: Page): Promise<void> {
  await expect(page.locator("[data-gated-write-applied='ungated']")).toBeVisible();
  await expect(approvalGate(page)).toHaveCount(0);
}

/**
 * A gated write is durable even when the operator is their own reviewer: the
 * Worker records a real Approval Request and the screen points at it.
 */
export async function expectApprovalRecord(page: Page): Promise<void> {
  const record = page.locator("[data-approval-record]");
  await expect(record).toBeVisible();
  await expect(record).toContainText("applied");
  await expect(approvalGate(page)).toHaveCount(0);
}
