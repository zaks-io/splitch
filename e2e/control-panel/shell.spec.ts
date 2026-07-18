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
});
