import { type BrowserContext, expect, type Page } from "@playwright/test";
import { fromJSON } from "seroval";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { LOCAL_E2E_PROMOTION } from "../../scripts/local-e2e-promotion-fixture.mjs";

/**
 * The gestures the Promotion specs share (SPL-122).
 *
 * `submittedSelect` is the load-bearing one: it reads the `select` the browser
 * actually put on the wire, so "the diff shown is the diff submitted" can be
 * asserted against the request rather than against another render of the same
 * state.
 */

const origin = "http://127.0.0.1:18793";

export const sourceEnv = LOCAL_E2E_PROMOTION.sourceEnvironmentKey;
export const targetEnv = LOCAL_E2E_PROMOTION.targetEnvironmentKey;
export const promotionFlags = LOCAL_E2E_PROMOTION.flags;

export async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
}

export async function openPromotion(page: Page, flagKey: string): Promise<void> {
  await page.goto(
    `/acme-labs/${LOCAL_E2E_PROMOTION.appSlug}/${targetEnv}/flags/${flagKey}/promote?from=${sourceEnv}`,
  );
  await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
  await expect(page.locator("[data-promotion-diff='true']")).toBeVisible();
}

export function tick(page: Page, rowId: string) {
  return page.locator(`[data-promotion-tick='${rowId}']`);
}

export function row(page: Page, rowId: string) {
  return page.locator(`[data-promotion-row='${rowId}']`);
}

/** The `select` the screen says it will send, read off the submit bar. */
export async function renderedSelect(page: Page): Promise<unknown> {
  const payload = await page
    .locator("[data-promotion-payload]")
    .getAttribute("data-promotion-payload");
  return JSON.parse(payload ?? "null");
}

/** The row ids the screen shows as ticked, read off the rows themselves. */
export async function tickedRowIds(page: Page): Promise<string[]> {
  return page
    .locator("[data-promotion-row-selected='true']")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-promotion-row") ?? ""));
}

/**
 * Clicks Promote and returns the `select` the browser sent.
 *
 * The request is awaited alongside the click rather than after it, so a payload
 * built at click time cannot slip past between the two.
 */
export async function submitAndCaptureSelect(page: Page): Promise<unknown> {
  const [request] = await Promise.all([
    page.waitForRequest(
      (candidate) =>
        candidate.method() === "POST" && (candidate.postData() ?? "").includes("fromEnvironmentId"),
    ),
    page.locator("[data-promotion-submit='true']").click(),
  ]);

  // TanStack serializes server-function arguments with seroval, so the body is
  // decoded with seroval itself rather than re-implementing its JSON node shape.
  const body = fromJSON(JSON.parse(request.postData() ?? "null")) as
    | { data?: { select?: unknown } }
    | undefined;
  return body?.data?.select;
}

export function approvalGate(page: Page) {
  return page.locator("[data-approval-gate]");
}

/** A gated Promotion leaves a real Approval Request behind, applied by the confirm. */
export async function confirmGateAndExpectRecord(page: Page): Promise<void> {
  await expect(approvalGate(page)).toBeVisible();
  await approvalGate(page).locator("[data-approval-confirm='true']").click();
  const record = page.locator("[data-approval-record]");
  await expect(record).toBeVisible();
  await expect(record).toContainText("applied");
  await expect(approvalGate(page)).toHaveCount(0);
}
