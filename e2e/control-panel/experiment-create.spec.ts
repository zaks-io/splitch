import { expect, type Page, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

/**
 * Experiment creation opens Run 1 through the SAME draft → Start machinery every
 * later Run uses. These specs walk the whole flow rather than asserting on
 * individual components, because the thing worth proving is that a draft
 * assembled step by step reaches `running` and that the Environment Policy gate
 * still applies on the way (ADR-0029).
 */
async function gotoHydrated(page: Page, href: string) {
  await page.goto(href);
  // Interacting before hydration submits the raw server-rendered form, which
  // navigates away instead of running the client validation being tested.
  await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
}

async function createDraft(page: Page, env: string, name: string, key: string) {
  await gotoHydrated(page, `/acme-labs/checkout-api/${env}/experiments/new`);
  await expect(page.getByRole("heading", { name: "New Experiment" })).toBeVisible();
  await page.locator("#experiment-name").fill(name);
  await page.locator("#experiment-key").fill(key);
  await page.locator("#experiment-flag").click();
  await page.getByRole("option", { name: "checkout-ended" }).click();
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/draft(\?|$)/);
}

/**
 * Metric names repeat across the fixture App, so the checkbox is addressed by
 * the Metric id the row carries rather than by its visible name.
 */
function metricCheckbox(page: Page, group: string, metricId: string) {
  return page
    .getByRole("group", { name: group, exact: true })
    .locator(`[data-metric-id="${metricId}"] [role="checkbox"]`);
}

async function saveMeasurementAndDecision(page: Page) {
  await expect(page.getByRole("heading", { name: "Metrics" })).toBeVisible();
  await metricCheckbox(page, "Goal Metrics", "checkout-conversion").check();
  await metricCheckbox(page, "Guardrail Metrics", "checkout-reliability").check();
  await page.locator("#draft-conversion-window").fill("48");
  await page.getByRole("button", { name: "Save and continue" }).click();

  await expect(page.getByRole("heading", { name: "Decision spec" })).toBeVisible();
  await page.locator("#draft-confidence-level").fill("0.9");
  await page.locator("#draft-dimensions").fill("country, plan");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Run", exact: true })).toBeVisible();
}

async function fillRunOneAndStart(page: Page) {
  await page.locator("#run-one-allocation-control").fill("50");
  await page.locator("#run-one-allocation-treatment").fill("50");
  await page.locator("#run-one-horizon").click();
  await page.getByRole("option", { name: /Fixed sample size/ }).click();
  await page.locator("#run-one-sample-size").fill("4000");
  await page.locator("#run-one-reason").fill("Opening Run 1 from the creation flow");
  await page.getByTestId("review-start-run").click();
  await page.getByRole("button", { name: "Start Run 1" }).click();
}

test.describe("Control Panel Experiment creation", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("walks a draft to a running Run 1 and locks the decision spec", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });

    await createDraft(page, "create-lab", "Run One Flow", "run-one-flow");
    const draftUrl = page.url().split("?")[0];
    await captureThemeScreenshots(page, testInfo, "experiment-create-measurement");

    // Leaving and coming back has to resume from the Control Plane, which is the
    // whole reason step 1 writes a real `draft` Experiment rather than holding
    // the wizard in browser state.
    await gotoHydrated(page, "/acme-labs/checkout-api/create-lab/experiments");
    await expect(page.getByRole("link", { name: "Run One Flow" })).toHaveAttribute(
      "href",
      /\/experiments\/.*\/draft$/,
    );
    await gotoHydrated(page, draftUrl);

    await saveMeasurementAndDecision(page);
    await captureThemeScreenshots(page, testInfo, "experiment-create-run-one");
    await fillRunOneAndStart(page);

    // Start lands on the Run's frozen Setup: the Run is seconds old, so what
    // confirms it landed is the configuration it froze, not statistics it cannot
    // have yet.
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: "Run One Flow" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Run 1/ })).toBeVisible();
    await expect(page.getByText("Running", { exact: true }).first()).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "experiment-create-started");

    // AC2, Panel half: the fields Run 1 froze are rendered as locked, not as an
    // editable form that would fail on submit (ADR-0023 — the Panel renders the
    // gate, the Worker enforces it; the Worker half is proven in
    // apps/control-plane-api/test/experiment-decision-spec.test.ts).
    await gotoHydrated(page, `${draftUrl}?step=decision`);
    const locked = page.getByTestId("decision-spec-locked");
    await expect(locked).toBeVisible();
    await expect(locked).toContainText("0.9");
    await expect(locked).toContainText("country, plan");
    await expect(page.locator("#draft-confidence-level")).toHaveCount(0);

    // AC3, Worker half: a refusal the Panel cannot pre-empt has to reach the
    // operator as the Control Plane's own words, not as a generic failure.
    await createDraft(page, "create-lab", "Same Flag Conflict", "same-flag-conflict");
    await saveMeasurementAndDecision(page);
    await page.locator("#run-one-allocation-control").fill("50");
    await page.locator("#run-one-allocation-treatment").fill("50");
    await page.getByTestId("review-start-run").click();
    await page.getByRole("button", { name: "Start Run 1" }).click();
    await expect(page.getByTestId("run-start-error")).toBeVisible();
  });

  test("reports draft problems per field and refuses to Start an incomplete draft", async ({
    page,
  }, testInfo) => {
    await gotoHydrated(page, "/acme-labs/checkout-api/create-lab/experiments/new");
    await page.getByRole("button", { name: "Create draft" }).click();

    await expect(page.getByText("Name this Experiment.")).toBeVisible();
    await expect(
      page.getByText("A key is required. It is unique per App and Environment."),
    ).toBeVisible();
    await expect(page.getByText("Choose the Flag this Experiment controls.")).toBeVisible();
    await expect(page).toHaveURL(/\/experiments\/new$/);
    await captureThemeScreenshots(page, testInfo, "experiment-create-field-errors");

    await page.locator("#experiment-name").fill("Incomplete Draft");
    await page.locator("#experiment-key").fill("Not A Key");
    await expect(page.getByText(/Use lowercase letters/)).toBeVisible();

    await createDraft(page, "create-lab", "Incomplete Draft", "incomplete-draft");
    // Straight to the last step, skipping the goal Metric choice: the draft is
    // not startable and says which step fixes it, rather than offering a Start
    // that would fail.
    await gotoHydrated(page, `${page.url().split("?")[0]}?step=run`);
    await expect(page.getByTestId("draft-not-startable")).toBeVisible();
    await expect(page.getByTestId("review-start-run")).toBeDisabled();

    // A goal Metric alone is not enough: the allocation still has to total 100.
    await gotoHydrated(page, `${page.url().split("?")[0]}?step=measurement`);
    await metricCheckbox(page, "Goal Metrics", "checkout-conversion").check();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await page.locator("#run-one-allocation-control").fill("50");
    await page.locator("#run-one-allocation-treatment").fill("10");
    await expect(page.getByText(/Allocation must total 100%/)).toBeVisible();
    await expect(page.getByTestId("review-start-run")).toBeDisabled();
  });

  test("routes Start through the Approval gate in a confirm Environment", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await createDraft(page, "create-gated", "Gated Run One", "gated-run-one");
    await saveMeasurementAndDecision(page);
    await fillRunOneAndStart(page);

    // The Start carried an inline `approve_and_apply` Review, so the Approval
    // Request the gate opened is already applied and Run 1 exists. A gate that
    // applied is not a pending one: the flow lands on the Run exactly as it does
    // under `allow`, and the confirmation raises nothing.
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByTestId("run-start-approval-request")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Run 1/ })).toBeVisible();
    await captureThemeScreenshots(page, testInfo, "experiment-create-gated-started");

    // The gated Start still opened a real Run, and the list has to say so: a Run
    // with no Exposures yet reads "Collecting data", never "Not active".
    await gotoHydrated(page, "/acme-labs/checkout-api/create-gated/experiments");
    const row = page.getByRole("row").filter({ hasText: "Gated Run One" });
    await expect(row).toContainText("Running");
    await expect(row).toContainText("Collecting data");
  });
});
