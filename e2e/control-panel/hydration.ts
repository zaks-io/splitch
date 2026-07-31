import { expect, type Page } from "@playwright/test";

/**
 * Every Control Panel shell (App, Org, and the Organization chooser) publishes
 * `data-hydrated` on its root marker; exactly one such root renders per screen.
 * Waiting on the attribute rather than a specific marker keeps one helper valid
 * for all of them, and a screen that never hydrates times out loudly here
 * instead of silently dropping the first interaction.
 */
export async function waitForHydration(page: Page, timeout = 10_000): Promise<void> {
  await expect(
    page.locator("[data-hydrated]").first(),
    "Control Panel hydration must complete before the first interaction",
  ).toHaveAttribute("data-hydrated", "true", { timeout });
}
