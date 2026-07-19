import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_ANALYSIS_RESULTS,
  LOCAL_E2E_FIXTURE_CONTRACT,
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
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
    expect(
      LOCAL_E2E_ANALYSIS_RESULTS.filter((fixture) => fixture.result.srm.srm_is_mismatch).map(
        (fixture) => fixture.environmentId,
      ),
    ).toEqual(["env_checkout_prod_e2e"]);

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
    await expect(shell).toHaveAttribute("data-hydrated", "true");
    await expect(shell).toHaveAttribute("data-app-id", "app_checkout_e2e");
    await expect(shell).toHaveAttribute("data-environment-id", "env_checkout_dev_e2e");
    await expect(page.getByRole("navigation", { name: "App sections" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Segments App-level" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Metrics App-level" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Segments App-level" }).getByText("App-level"),
    ).toBeVisible();
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

    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
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
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");
    await chooseScope(page, "Environment", target);
    await expect(page).toHaveURL(target);
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute(
      "data-environment-id",
      "env_checkout_prod_e2e",
    );
    expect(await page.locator("[data-app-shell='ready']").innerText()).toBe(coldShell);
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
