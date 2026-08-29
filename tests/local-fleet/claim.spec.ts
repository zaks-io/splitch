import { expect, test } from "@playwright/test";
import { captureThemeScreenshots } from "../../e2e/control-panel/screenshot";

const sessionToken = process.env.SPLITCH_LOCAL_FLEET_SESSION;

test.describe("local fleet claim ceremony", () => {
  test.skip(!sessionToken, "SPLITCH_LOCAL_FLEET_SESSION seeds the isolated local panel session");

  test("renders the provisional Organization claim path in light and dark mode", async ({
    context,
    page,
  }, testInfo) => {
    await context.addCookies([
      {
        name: "__session",
        value: sessionToken as string,
        url: process.env.SPLITCH_LOCAL_FLEET_CONTROL_PANEL_ORIGIN ?? "http://127.0.0.1:8793",
      },
    ]);

    await page.goto("/demo-workspace/claim");
    await expect(page.getByRole("heading", { name: "Claim Organization" })).toBeVisible();
    await expect(page.getByLabel("Identity assertion")).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send one-time password" })).toBeVisible();

    await captureThemeScreenshots(page, testInfo, "claim");
  });
});
