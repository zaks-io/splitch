import { expect, type Page } from "@playwright/test";
import type { PanelCredentials, SmokeConfig } from "./smoke-config";

/**
 * Drives a real WorkOS AuthKit sign-in against the deployed Control Panel. There is no
 * shortcut worth taking here: the panel session is minted only by the `/auth/callback`
 * code exchange, so anything cheaper would stop proving that hosted login works.
 */
export async function signInThroughAuthKit(
  page: Page,
  config: SmokeConfig,
  credentials: PanelCredentials,
): Promise<void> {
  const loginUrl = `${config.panelBaseUrl}/auth/login?returnTo=%2F`;
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  } catch (cause) {
    // A DNS, TLS, or connection-refused failure never reaches the step assertions below,
    // so name the origin and the variable that sets it here or the cause is unstated.
    throw new Error(
      `Could not open the Control Panel login at ${loginUrl}. Check the deploy is serving ` +
        `this origin; it comes from SPLITCH_SMOKE_PANEL_BASE_URL (${config.panelBaseUrl}). ` +
        `Underlying failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  await assertAuthKitAccepted(page, config);

  const email = page.locator('input[type="email"]').first();
  await expect(email, authKitStepFailure(page, "email")).toBeVisible({ timeout: 20_000 });
  await email.fill(credentials.email);
  await advance(page);

  const password = page.locator('input[type="password"]').first();
  await expect(password, authKitStepFailure(page, "password")).toBeVisible({ timeout: 20_000 });
  await password.fill(credentials.password);
  await advance(page);

  // Back on the panel outside /auth/ means the callback code exchange minted a session;
  // a bounce back to /auth/login means it did not.
  await page.waitForURL(
    (url) => url.origin === config.panelBaseUrl && !url.pathname.startsWith("/auth/"),
    { timeout: 30_000 },
  );
}

async function advance(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /continue|sign in|log in/i })
    .first()
    .click();
}

/**
 * AuthKit refuses the whole flow when the panel's callback URL is not registered for the
 * WorkOS environment, and it does so on a page that looks superficially like a login
 * screen. Name the exact dashboard change, or this failure reads as a flaky selector.
 */
async function assertAuthKitAccepted(page: Page, config: SmokeConfig): Promise<void> {
  const url = new URL(page.url());
  if (!url.pathname.includes("redirect-uri-invalid")) {
    return;
  }
  const invalid =
    url.searchParams.get("invalid_redirect_uri") ?? `${config.panelBaseUrl}/auth/callback`;
  throw new Error(
    [
      `WorkOS rejected the Control Panel callback URL: ${invalid}`,
      `AuthKit environment: ${url.host}`,
      `client_id: ${url.searchParams.get("client_id") ?? "unknown"}`,
      "",
      "Register the callback in the WorkOS Dashboard (Applications -> Redirects) for this",
      "environment. Redirect URIs are dashboard-managed; no API credential can add them,",
      "so hosted panel login stays broken until a human does this.",
    ].join("\n"),
  );
}

function authKitStepFailure(page: Page, step: string): string {
  return [
    `AuthKit ${step} step never rendered (currently at ${page.url()}).`,
    "Either the deploy is not serving the Control Panel login at the configured",
    "SPLITCH_SMOKE_PANEL_BASE_URL, or AuthKit refused the sign-in before this step.",
  ].join(" ");
}
