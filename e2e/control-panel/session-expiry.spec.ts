import { expect, test } from "@playwright/test";
import { LOCAL_E2E_SESSION_TOKEN } from "../../scripts/local-e2e-fixtures.mjs";
import { waitForHydration } from "./hydration";

const origin = "http://127.0.0.1:18793";

// `/auth/login` is a server-only route, so it does not exist in the client
// route tree. A session that dies under a hydrated app (WorkOS expiry, sign-out
// in another tab) must still land on AuthKit from an in-app click, not on the
// router's Not Found page.
test.describe("Session expiry during client-side navigation", () => {
  test("sends the browser through the sign-in door instead of rendering Not Found", async ({
    context,
    page,
  }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
    await page.goto("/acme-labs/checkout-api/dev");
    await waitForHydration(page);

    await context.clearCookies();
    // Let the Worker answer the sign-in door for real, then stop the hop at
    // AuthKit instead of letting the browser leave the harness: the local fleet
    // signs in against placeholder WorkOS credentials.
    const doorAnswers: Array<{ navigation: boolean; returnTo: string | null; location: string }> =
      [];
    await page.route("**/auth/login?*", async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      doorAnswers.push({
        navigation: route.request().isNavigationRequest(),
        returnTo: new URL(route.request().url()).searchParams.get("returnTo"),
        location: response.headers().location ?? "",
      });
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<title>AuthKit</title>",
      });
    });

    await page
      .getByRole("navigation", { name: "App sections" })
      .getByRole("link", { name: "Flags" })
      .click();
    await expect(page).toHaveTitle("AuthKit");

    // The App shell's loader and the Flags loader both gate on the session and
    // both run on this transition, so the door can answer more than once; every
    // answer must be the same full-document hop to AuthKit.
    expect(doorAnswers.length).toBeGreaterThan(0);
    for (const answer of doorAnswers) {
      expect(answer).toEqual({
        navigation: true,
        returnTo: "/acme-labs/checkout-api/dev/flags",
        location: expect.stringContaining("https://api.workos.com/user_management/authorize"),
      });
    }
    await expect(page.getByText("Not Found")).toHaveCount(0);
  });
});
