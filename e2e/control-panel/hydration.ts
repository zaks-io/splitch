import { expect, type Page } from "@playwright/test";

export async function waitForHydration(page: Page, timeout = 10_000): Promise<void> {
  await expect(
    page.locator('[data-app-shell="ready"]'),
    "Control Panel hydration must complete before the first interaction",
  ).toHaveAttribute("data-hydrated", "true", { timeout });
}
