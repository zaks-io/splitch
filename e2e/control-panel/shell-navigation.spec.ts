import { expect, test } from "@playwright/test";
import {
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";

/**
 * Copy that reports the state of the implementation instead of teaching the
 * product. Deliberately duplicated from the Control Panel unit contract so the
 * rendered shell is judged independently of the navigation config that built it.
 */
const IMPLEMENTATION_STATUS_COPY = [
  /arrives in (its|a|the) [\w -]*slice/i,
  /dedicated screen slice/i,
  /not (yet )?implemented/i,
  /lands in a (later|future) slice/i,
  /under construction/i,
];

/**
 * A working screen may disable one affordance and say so. A screen whose
 * *headline* says it is unfinished is a destination that leads nowhere.
 */
const STATUS_HEADLINE = /coming soon|placeholder|under construction|unavailable/i;

// The honest-shell contract: nothing the Panel shows may lead nowhere, and
// hiding a destination never changes what the Worker answers for it.
test.describe("Honest Control Panel shell navigation", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("lands every visible navigation destination on product UI, never status copy", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/acme-labs/checkout-api/dev");
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");

    const nav = page.getByRole("navigation", { name: "App sections" });
    const destinations = await nav.getByRole("link").evaluateAll((links) =>
      links.map((link) => ({
        href: link.getAttribute("href") ?? "",
        label: (link.textContent ?? "").trim(),
      })),
    );
    expect(destinations.length).toBeGreaterThan(0);
    expect(destinations.map((destination) => destination.label).join(" | ")).not.toContain(
      "Segments",
    );

    for (const destination of destinations) {
      // Walk the shell the way a person does, by clicking the nav item. Cold
      // deep links for the same URLs are proven separately in shell.spec.ts.
      await nav.locator(`a[href="${destination.href}"]`).click();
      await expect(page).toHaveURL(destination.href);
      await expect(
        page.locator("[data-slot='error-page']"),
        `${destination.label} (${destination.href}) renders product UI, not an error surface`,
      ).toHaveCount(0);
      const main = page.locator("[data-app-shell='ready'] > div > main");
      await expect(
        main,
        `${destination.label} (${destination.href}) renders the App shell`,
      ).toBeVisible();
      await expect(main, `${destination.label} renders content`).not.toBeEmpty();
      const copy = (await main.innerText()).trim();
      for (const pattern of IMPLEMENTATION_STATUS_COPY) {
        expect(copy, `${destination.label} (${destination.href})`).not.toMatch(pattern);
      }
      const headline = (await main.getByRole("heading").first().innerText()).trim();
      expect(headline, `${destination.label} headline`).not.toMatch(STATUS_HEADLINE);
    }

    // The contract is the shell itself, so prove it once in each theme rather
    // than paying for ten full-page captures on a serial fleet.
    await captureThemeScreenshots(page, testInfo, "honest-shell-navigation");
  });

  test("keeps development-only surfaces out of the hosted product header", async ({ page }) => {
    for (const path of ["/", "/acme-labs/checkout-api/dev"]) {
      await page.goto(path);
      const header = page.locator("body > div > header").first();
      await expect(header).toBeVisible();
      await expect(header.getByRole("link", { name: /kitchen/i })).toHaveCount(0);
      await expect(header.locator("a[href='/kitchen-sink']")).toHaveCount(0);
      expect(
        await header
          .getByRole("link")
          .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
      ).toEqual(["/", "/auth/logout"]);
    }

    // Hiding the link is a UI decision only: the development surface itself is
    // untouched and the Worker still answers it exactly as before.
    const kitchenSink = await page.request.get("/kitchen-sink", { maxRedirects: 0 });
    expect(kitchenSink.status()).toBe(200);
  });

  test("answers hidden and refused deep links from the Worker, never a client redirect", async ({
    context,
    page,
    request,
  }) => {
    // Segments is hidden from navigation while SPL-112 is unfinished. Hiding the
    // link must not change what a direct request gets back.
    const hidden = await page.request.get("/acme-labs/checkout-api/dev/segments", {
      maxRedirects: 0,
    });
    expect(hidden.status()).toBe(200);
    expect(hidden.headers().location).toBeUndefined();

    const signedOut = await request.get("/acme-labs/checkout-api/dev/segments", {
      maxRedirects: 0,
    });
    expect([302, 307]).toContain(signedOut.status());
    expect(signedOut.headers().location).toContain("/auth/login?returnTo=");

    // An invalid deep link still resolves to the Worker's 404, hidden or not.
    await page.goto("/acme-labs/no-such-app/dev/segments");
    await expect(page.getByText("The requested App or Environment was not found.")).toBeVisible();

    // And an unauthorized one still resolves to the Worker's 403, not to a
    // client-side redirect that papers over the refusal.
    await context.clearCookies();
    await context.addCookies([
      { name: "__session", value: LOCAL_E2E_MEMBER_SESSION_TOKEN, url: origin },
    ]);
    await page.goto("/orbit-tools/agent-console/prod/segments");
    await expect(page).toHaveURL("/orbit-tools/agent-console/prod/segments");
    const denial = page.locator("[data-slot='error-page']");
    await expect(denial).toContainText("403");
    await expect(denial).toContainText("Access denied");
  });

  test("reaches every visible shell action by keyboard with a visible focus state", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/acme-labs/checkout-api/dev");
    await expect(page.locator("[data-app-shell='ready']")).toHaveAttribute("data-hydrated", "true");

    const expected = new Set(
      await page
        .locator("body > div > header a, [aria-label='App sections'] a")
        .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? "")),
    );
    expect(expected.size).toBeGreaterThan(0);

    const reached = new Set<string>();
    for (let step = 0; step < 40 && reached.size < expected.size; step += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        if (!(element instanceof HTMLAnchorElement)) return null;
        const style = getComputedStyle(element);
        return {
          href: element.getAttribute("href") ?? "",
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      if (!focused || !expected.has(focused.href)) continue;
      expect(focused.outlineStyle, `focus ring on ${focused.href}`).not.toBe("none");
      expect(
        Number.parseFloat(focused.outlineWidth),
        `focus ring width on ${focused.href}`,
      ).toBeGreaterThan(0);
      reached.add(focused.href);
    }

    expect([...reached].sort()).toEqual([...expected].sort());
  });
});
