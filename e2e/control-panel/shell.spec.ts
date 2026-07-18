import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
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
