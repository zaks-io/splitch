import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_FIXTURE_CONTRACT,
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

test.describe("Control Panel local full-stack harness", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("accepts the KV-seeded session and proves the template shell", async ({
    page,
  }, testInfo) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Control Panel" })).toBeVisible();
    await expect(page.locator("[data-org-slug='acme-labs']")).toBeVisible();
    await expect(page.locator("[data-org-slug='orbit-tools']")).toBeVisible();
    await expect(page.getByText("checkout-api")).toBeVisible();
    await expect(page.getByText("agent-console")).toBeVisible();
    // The hosted product header carries product destinations only; the Kitchen
    // Sink stays a local visual-development surface.
    const header = page.locator("body > div > header").first();
    await expect(header.locator("a[href='/kitchen-sink']")).toHaveCount(0);
    await expect(header.getByRole("link", { name: /kitchen/i })).toHaveCount(0);

    await captureThemeScreenshots(page, testInfo, "template-shell");
  });

  test("rejects a tampered session through the real loader validation path", async ({
    request,
  }) => {
    const finalCharacter = LOCAL_E2E_SESSION_TOKEN.endsWith("0") ? "1" : "0";
    const tamperedToken = `${LOCAL_E2E_SESSION_TOKEN.slice(0, -1)}${finalCharacter}`;
    const response = await request.get("/", {
      headers: { cookie: `__session=${tamperedToken}` },
      maxRedirects: 0,
    });

    expect([302, 307]).toContain(response.status());
    expect(response.headers().location).toContain("/auth/login?returnTo=");
  });

  test("proves member identity, explicit Environments, and attention placement before UI work", async ({
    context,
    page,
  }) => {
    const environments = LOCAL_E2E_FIXTURE_CONTRACT.app.environments;
    expect(environments).toHaveLength(2);
    expect(environments.map((environment) => environment.key)).toEqual(["dev", "prod"]);
    expect(
      environments.filter((environment) => environment.attention.state === "attention"),
    ).toEqual([
      expect.objectContaining({
        id: "env_checkout_prod_e2e",
        attention: { state: "attention", srm: true, guardrail: false },
      }),
    ]);
    const accessToken = await page.request
      .get("http://127.0.0.1:18788/token")
      .then(async (response) => (await response.json()).accessToken);
    expect(typeof accessToken).toBe("string");
    // Results are addressed at the Control Plane, not at the Analysis Worker that
    // executes them (ADR-0046). Analysis has no public door, so these requests go
    // to the surface that authorizes them and forwards over the binding.
    const unauthorized = await page.request.get(
      "http://127.0.0.1:18790/apps/app_checkout_e2e/envs/env_checkout_dev_e2e/experiments/experiment_checkout_dev_e2e/results",
    );
    expect(unauthorized.status()).toBe(401);
    // Cross-App probe: the token is scoped to app_checkout_e2e, so the generic
    // co-scope guard refuses the path App before any tenant table is read.
    const wrongApp = await page.request.get(
      "http://127.0.0.1:18790/apps/app_billing_e2e/envs/env_checkout_dev_e2e/experiments/experiment_checkout_dev_e2e/results",
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(wrongApp.status()).toBe(403);
    // Foreign-Environment probe: the path App IS the credential's App, so the
    // co-scope guard passes and only the delegation handler's own check stands
    // between a control-plane token and another App's Environment. A
    // control-plane token is legitimately Environment-unbound (ADR-0027), so
    // without that check this reads across the tenant boundary.
    const foreignEnvironment = await page.request.get(
      "http://127.0.0.1:18790/apps/app_checkout_e2e/envs/env_billing_prod_e2e/experiments/experiment_checkout_dev_e2e/results",
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(foreignEnvironment.status()).toBe(404);
    expect((await foreignEnvironment.json()).code).toBe("APP_NOT_FOUND");
    // The old address must stay closed, or the authorization above is optional.
    const bypass = await page.request.get(
      "http://127.0.0.1:8790/apps/app_checkout_e2e/envs/env_checkout_dev_e2e/experiments/experiment_checkout_dev_e2e/results",
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    expect(bypass.status()).toBe(404);

    const analysisResults = await Promise.all(
      environments.map(async (environment) => {
        const experimentId = `experiment_checkout_${environment.key}_e2e`;
        const response = await page.request.get(
          `http://127.0.0.1:18790/apps/app_checkout_e2e/envs/${environment.id}/experiments/${experimentId}/results`,
          { headers: { authorization: `Bearer ${accessToken}` } },
        );
        expect(response.status()).toBe(200);
        return { environmentId: environment.id, result: await response.json() };
      }),
    );
    // The analysis-api /results read answers with an AnalysisResultsEnvelope
    // (state, run_id, control_variant, stats|missing), not a bare StatsOutput
    // (#200 / SPL-302): srm
    // lives under `.stats`, alongside the run_id provenance the envelope now
    // carries.
    expect(
      analysisResults
        .filter(({ result }) => result.stats.srm.srm_is_mismatch)
        .map(({ environmentId }) => environmentId),
    ).toEqual(["env_checkout_prod_e2e"]);
    expect(
      analysisResults.find(({ environmentId }) => environmentId.endsWith("dev_e2e"))?.result.stats
        .srm.srm_p_value,
    ).toBe(1);
    expect(
      analysisResults.find(({ environmentId }) => environmentId.endsWith("prod_e2e"))?.result.stats
        .srm.srm_p_value,
    ).toBeCloseTo(0.00005699411623331831, 15);

    await context.clearCookies();
    await context.addCookies([
      { name: "__session", value: LOCAL_E2E_MEMBER_SESSION_TOKEN, url: origin },
    ]);
    await page.goto("/");
    await expect(page.getByText("user_local_member_e2e")).toBeVisible();
    await expect(
      page.locator("[data-org-slug='acme-labs']").getByText("member").first(),
    ).toBeVisible();
    await expect(page.getByText("checkout-api")).toBeVisible();
    await expect(page.locator("[data-org-slug='orbit-tools']")).toHaveCount(0);

    await page.goto("/acme-labs");
    await expect(page.getByRole("link", { name: "Development" })).toHaveAttribute(
      "href",
      "/acme-labs/checkout-api/dev",
    );
    await expect(page.getByRole("link", { name: "Production" })).toHaveAttribute(
      "href",
      "/acme-labs/checkout-api/prod",
    );

    await page.goto("/orbit-tools");
    const denial = page.getByRole("alert");
    await expect(denial).toContainText("Access denied");
    await expect(denial).toContainText("You are not a member of this Organization.");
  });

  test("opens the same-origin, session-authorized live-update socket", async ({ page }) => {
    await page.goto("/acme-labs/checkout-api/dev");

    await expect(
      page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const socket = new WebSocket(`${location.origin}/acme-labs/checkout-api/dev/live`);
            const timeout = window.setTimeout(() => {
              socket.close();
              resolve(false);
            }, 5_000);
            socket.addEventListener(
              "open",
              () => {
                window.clearTimeout(timeout);
                socket.close();
                resolve(true);
              },
              { once: true },
            );
            socket.addEventListener(
              "error",
              () => {
                window.clearTimeout(timeout);
                resolve(false);
              },
              { once: true },
            );
          }),
      ),
    ).resolves.toBe(true);
  });

  test("renders the URL-derived App shell and preserves the section across Environment switches", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/acme-labs/checkout-api/dev/flags");

    const shell = page.locator("[data-app-shell='ready']");
    await waitForHydration(page);
    await expect(shell).toHaveAttribute("data-app-id", "app_checkout_e2e");
    await expect(shell).toHaveAttribute("data-environment-id", "env_checkout_dev_e2e");
    const nav = page.getByRole("navigation", { name: "App sections" });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("link", { name: "Segments App-level" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Segments App-level" }).getByText("App-level"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Metrics App-level" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Metrics App-level" }).getByText("App-level"),
    ).toBeVisible();

    await chooseScope(page, "Environment", "/acme-labs/checkout-api/prod/flags");
    await expect(page).toHaveURL("/acme-labs/checkout-api/prod/flags");
    await expect(shell).toHaveAttribute("data-environment-id", "env_checkout_prod_e2e");
    await expect(shell).not.toHaveAttribute("data-environment-id", "env_checkout_dev_e2e");

    await captureThemeScreenshots(page, testInfo, "app-shell");
  });

  test("uses explicit App and Organization destinations without an implicit Environment", async ({
    page,
  }) => {
    await page.goto("/acme-labs/checkout-api/dev");

    await waitForHydration(page);
    await chooseScope(page, "App", "/acme-labs/billing-api/prod");
    await expect(page).toHaveURL("/acme-labs/billing-api/prod");
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute(
      "data-app-id",
      "app_billing_e2e",
    );

    await chooseScope(page, "Organization", "/orbit-tools");
    await expect(page).toHaveURL("/orbit-tools");
    await expect(page.getByRole("heading", { name: "orbit-tools" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Production" })).toHaveAttribute(
      "href",
      "/orbit-tools/agent-console/prod",
    );
  });

  test("cold deep links match client-side navigation for the same shell URL", async ({ page }) => {
    const target = "/acme-labs/checkout-api/prod/metrics";
    await page.goto(target);
    const coldShell = await page.locator("[data-app-shell='ready']").innerText();

    await page.goto("/acme-labs/checkout-api/dev/metrics");
    await waitForHydration(page);
    await chooseScope(page, "Environment", target);
    await expect(page).toHaveURL(target);
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute(
      "data-environment-id",
      "env_checkout_prod_e2e",
    );
    expect(await page.locator("[data-app-shell='ready']").innerText()).toBe(coldShell);
  });

  test("waits for hydration before an immediate interaction", async ({ page }) => {
    await page.route("**/*", async (route) => {
      if (route.request().resourceType() === "script") {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await route.continue();
    });
    await page.goto("/acme-labs/checkout-api/dev/flags", { waitUntil: "commit" });

    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute(
      "data-hydrated",
      "false",
    );
    await waitForHydration(page);
    await page.getByRole("link", { name: "Metrics App-level" }).click();

    await expect(page).toHaveURL("/acme-labs/checkout-api/dev/metrics");
  });

  test("surfaces stale data after server loss and clears it only after refetch recovery", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/checkout-api/dev");
    await expect(page.getByText("Data may be out of date")).toBeHidden();
    await setLiveUpdateServer(testInfo, "down");
    await expect(page.getByText("Data may be out of date")).toBeVisible();
    await setLiveUpdateServer(testInfo, "up");
    await expect(page.getByText("Data may be out of date")).toBeHidden();
  });

  test.afterAll(async ({ request }, workerInfo) => {
    const runId = workerInfo.project.metadata.localE2eRunId;
    expect(typeof runId).toBe("string");
    const response = await request.get(`http://127.0.0.1:18799/health?run=${runId}`);
    expect(response.ok()).toBe(true);
  });
});

async function chooseScope(page: import("@playwright/test").Page, label: string, href: string) {
  const switcher = page.locator("details").filter({ has: page.getByText(label, { exact: true }) });
  await switcher.locator("summary").click();
  await switcher.locator(`a[href='${href}']`).click();
}

async function setLiveUpdateServer(
  testInfo: { project: { metadata: Record<string, unknown> } },
  state: "up" | "down",
): Promise<void> {
  const runId = testInfo.project.metadata.localE2eRunId;
  if (typeof runId !== "string") throw new Error("missing local E2E run ID");
  const response = await fetch(
    `http://127.0.0.1:18790/__test/live-updates/app_checkout_e2e/env_checkout_dev_e2e/${state}`,
    { method: "POST", headers: { "x-splitch-local-e2e-run-id": runId } },
  );
  expect(response.ok).toBe(true);
}
