import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("Org shell and App list", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("the root screen is a chooser that lands you on an Organization", async ({
    page,
  }, testInfo) => {
    await page.goto("/");

    // No hidden default: the Organization is picked, not assumed, even though the
    // destination is one click away.
    await page.locator("[data-org-slug='acme-labs'] a").click();
    await expect(page).toHaveURL("/acme-labs");
    await expect(page.locator("[data-org-shell='ready']")).toHaveAttribute("data-org", "acme-labs");
    await expect(page.getByRole("heading", { name: "acme-labs" })).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "org-app-list");
  });

  test("the App card is the Environment picker, and nothing links to a bare App", async ({
    page,
  }) => {
    await page.goto("/acme-labs");

    const card = page.locator("[data-app-card='checkout-api']");
    await expect(card).toBeVisible();
    // The App name is a label. Selecting it is not a destination, because a
    // destination would have to invent an Environment.
    await expect(card.getByRole("heading", { name: "checkout-api" })).toBeVisible();
    await expect(card.getByRole("link", { name: "checkout-api" })).toHaveCount(0);
    await expect(card.locator("a[href='/acme-labs/checkout-api/dev']")).toBeVisible();
    await expect(card.locator("a[href='/acme-labs/checkout-api/prod']")).toBeVisible();

    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href") ?? ""));
    expect(hrefs.filter((href) => /^\/acme-labs\/[^/?#]+$/.test(href))).toEqual([]);

    await page.locator("a[href='/acme-labs/checkout-api/prod']").click();
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute(
      "data-environment-id",
      "env_checkout_prod_e2e",
    );
  });

  test("an unreadable attention rollup is stated per Environment, never rendered as calm", async ({
    page,
  }) => {
    // The local fleet cannot serve the rollup: control-plane-api reaches
    // splitch-analysis-api over a NAMED-entrypoint service binding
    // (`#ControlPlaneEntrypoint`), and across two `wrangler dev` processes the
    // dev registry delivers the call to the default export instead, so the
    // Analysis read comes back 401 and the rollup refuses with
    // SERVICE_UNAVAILABLE. That makes this fleet's honest assertion the
    // fail-loud one; the clear/attention split is proven against the contract in
    // org-app-list.test.ts until the fleet binds the entrypoint.
    await page.goto("/acme-labs");

    const card = page.locator("[data-app-card='checkout-api']");
    for (const environmentId of ["env_checkout_dev_e2e", "env_checkout_prod_e2e"]) {
      await expect(
        card.locator(`[data-attention-environment-id='${environmentId}']`),
      ).toHaveAttribute("data-attention-state", "unknown");
    }
    await expect(card.locator("[data-app-attention-summary='checkout-api']")).toContainText(
      "Experiment health unavailable",
    );
    // The reason travels with the refusal instead of an absent marker (ADR-0036).
    await expect(card).toContainText("analysis attention data is unavailable");
    // The marker must not rename the link it decorates.
    await expect(card.getByRole("link", { name: "Production", exact: true })).toBeVisible();
  });

  test("an owner creates an App and it appears in the Organization that owns it", async ({
    page,
  }) => {
    const slug = `e2e-app-${Date.now().toString(36)}`;
    await page.goto("/acme-labs");
    await expect(page.locator("[data-org-shell='ready']")).toHaveAttribute("data-hydrated", "true");
    await page.getByTestId("create-app").click();
    await page.getByLabel("App name").fill(slug);
    await page.getByLabel("URL slug").fill(slug);
    await page.locator("form").getByRole("button", { name: "Create App" }).click();

    const created = page.locator(`[data-app-card='${slug}']`);
    await expect(created).toBeVisible();
    // dev and prod are provisioned with the App (ADR-0027), so the card is
    // immediately usable rather than a dead entry.
    await expect(created.locator(`a[href='/acme-labs/${slug}/dev']`)).toBeVisible();
    await expect(created.locator(`a[href='/acme-labs/${slug}/prod']`)).toBeVisible();

    await page.goto("/orbit-tools");
    await expect(page.locator(`[data-app-card='${slug}']`)).toHaveCount(0);
  });

  test("a member sees Create App locked, and the Worker refuses it when forced", async ({
    browser,
    page,
  }) => {
    // Discover the real create-App request from the path the panel actually uses,
    // so the forced call is the same call the UI would make.
    const slug = `e2e-forced-${Date.now().toString(36)}`;
    const createRequest = page.waitForRequest(
      (request) => request.method() === "POST" && (request.postData() ?? "").includes(slug),
    );
    await page.goto("/acme-labs");
    await expect(page.locator("[data-org-shell='ready']")).toHaveAttribute("data-hydrated", "true");
    await page.getByTestId("create-app").click();
    await page.getByLabel("App name").fill(slug);
    await page.getByLabel("URL slug").fill(slug);
    await page.locator("form").getByRole("button", { name: "Create App" }).click();
    const captured = await createRequest;

    // A manually created context does not inherit the project's `use` options.
    const memberContext = await browser.newContext({ baseURL: origin });
    await memberContext.addCookies([
      { name: "__session", value: LOCAL_E2E_MEMBER_SESSION_TOKEN, url: origin },
    ]);
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/acme-labs");

    await expect(memberPage.getByTestId("create-app")).toHaveCount(0);
    const locked = memberPage.getByTestId("create-app-locked");
    await expect(locked).toBeVisible();
    await expect(locked).toBeDisabled();

    const forced = await memberPage.request.fetch(captured.url(), {
      method: "POST",
      headers: captured.headers(),
      data: (captured.postData() ?? "").replace(slug, `${slug}-forced`),
    });
    const body = await forced.text();

    // The refusal is stated, not swallowed into an empty list (ADR-0036).
    expect(body).toMatch(/forbidden|not allowed|permission|role/i);
    await memberPage.goto("/acme-labs");
    await expect(memberPage.locator(`[data-app-card='${slug}-forced']`)).toHaveCount(0);

    await memberContext.close();
  });
});
