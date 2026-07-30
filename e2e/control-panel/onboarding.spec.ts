import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_ONBOARDING_APP_SLUGS,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

function flagsPath(test: keyof typeof LOCAL_E2E_ONBOARDING_APP_SLUGS): string {
  return `/acme-labs/${LOCAL_E2E_ONBOARDING_APP_SLUGS[test]}/prod/flags`;
}

/**
 * The visual quickstart, from an empty Flags surface to the handoff that sends a
 * developer to their own editor (screen-inventory.md#onboarding).
 *
 * The journey starts at an existing App on purpose: Create App is SPL-103's
 * screen, and the hosted golden path that begins at org creation is SPL-124.
 *
 * "Test this Flag" exercises the real verify seam, but the local fleet does not
 * run evaluation-api (SPL-193, blocked on SPL-181/#205), so the reachable
 * assertion here is the fail-loud one: an unreachable data plane must render as
 * an unmistakable failure and never as a green check. The green resolution path
 * is proven in `apps/control-panel/src/lib/panel-verify.test.ts`, and the
 * zero-Exposure invariant at the real boundary in
 * `apps/evaluation-api/src/verify.test.ts`.
 */
test.describe("onboarding: connect your code", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  // Each test owns an empty App of its own. Flags are App-scoped, so sharing one
  // would make the empty-state assertion depend on execution order and break on
  // a retry that re-enters an App its own first attempt already wrote to.
  test("teaches the empty Flags surface with executable CLI and MCP equivalents", async ({
    page,
  }, testInfo) => {
    await page.goto(flagsPath("emptyState"));

    await expect(page.getByText("Create your first Flag")).toBeVisible();
    await expect(page.getByText("A Flag is a named toggle with Variants.")).toBeVisible();

    const parity = page.getByTestId("parity-note");
    await expect(parity).toContainText("splitch flags create");
    await expect(parity).toContainText("flags_create");
    await expect(page.getByRole("button", { name: "Create Flag" })).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "onboarding-flags-empty");
  });

  test("hands over a real Client Key, install command, and contract-correct snippet", async ({
    page,
  }, testInfo) => {
    const flagKey = `onboarding-connect-${testInfo.retry}`;
    await page.goto(flagsPath("connect"));
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");

    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Flag key").fill(flagKey);
    await dialog.getByRole("button", { name: "Create Flag" }).click();

    await expect(dialog.getByRole("heading", { name: "Connect your code" })).toBeVisible();
    const card = dialog.getByTestId("connect-your-code");
    await expect(card).toBeVisible();

    // The Client Key is public and is shown in full, substituted for real.
    const clientKey = (await card.getByTestId("connect-client-key").innerText()).trim();
    expect(clientKey.length).toBeGreaterThan(0);
    expect(clientKey).not.toContain("…");
    expect(clientKey).not.toContain("...");

    await expect(card.getByTestId("connect-install")).toHaveText("npm install @splitch/sdk");

    const snippet = await card.getByTestId("connect-snippet").innerText();
    expect(snippet).toContain(`clientKey: "${clientKey}"`);
    expect(snippet).toContain(`splitch.evaluate("${flagKey}"`);
    expect(snippet).toContain("idempotencyKey: evaluationId");
    // The shipped client takes no appId; scope comes from the credential.
    expect(snippet).not.toContain("appId");

    // The secret API Key is never redisplayed: the server path points at
    // Settings and reads the key from the environment.
    await card.getByText("Running on a trusted server instead?").click();
    const serverSnippet = await card.getByTestId("connect-server-snippet").innerText();
    expect(serverSnippet).toContain("process.env.SPLITCH_API_KEY");
    expect(await card.innerText()).not.toMatch(/\bsk_[A-Za-z0-9]/);

    await captureThemeScreenshots(page, testInfo, "onboarding-connect-card");
  });

  test("fails loud when verify cannot reach the data plane", async ({ page }, testInfo) => {
    const flagKey = `onboarding-verify-${testInfo.retry}`;
    await page.goto(flagsPath("verify"));
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");

    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Flag key").fill(flagKey);
    await dialog.getByRole("button", { name: "Create Flag" }).click();

    const verifyPanel = dialog.getByTestId("verify-panel");
    await expect(verifyPanel).toBeVisible();
    await expect(verifyPanel).toContainText("without recording an Exposure");
    await expect(verifyPanel).toContainText(`splitch flags verify ${flagKey}`);
    await expect(verifyPanel).toContainText("flags_test_eval");

    await verifyPanel.getByLabel("Test this Flag for a targeting key").fill("user-42");
    await verifyPanel.getByRole("button", { name: "Test" }).click();

    // evaluation-api is not in the local fleet, so this must surface as a
    // failure. A success shape appearing here would be the bug.
    await expect(verifyPanel.getByTestId("verify-error")).toBeVisible();
    await expect(verifyPanel.getByTestId("verify-success")).toHaveCount(0);
    await expect(verifyPanel.getByTestId("verify-error")).not.toContainText("Resolved to");

    await captureThemeScreenshots(page, testInfo, "onboarding-verify-failed-loud");
  });

  test("points at the first real Exposure as the finish line", async ({ page }, testInfo) => {
    const flagKey = `onboarding-exposure-${testInfo.retry}`;
    await page.goto(flagsPath("exposure"));
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");

    await page.getByRole("button", { name: "Create Flag" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Flag key").fill(flagKey);
    await dialog.getByRole("button", { name: "Create Flag" }).click();

    const nudge = dialog.getByTestId("first-exposure-nudge");
    await expect(nudge).toContainText("evaluate()");
    await expect(nudge).toContainText("first Exposure");

    await dialog
      .locator("[data-slot='dialog-footer']")
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.locator(`[data-flag-key='${flagKey}']`)).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "onboarding-after-close");
  });
});
