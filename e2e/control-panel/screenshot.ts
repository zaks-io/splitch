import type { Page, TestInfo } from "@playwright/test";

export async function captureThemeScreenshots(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: testInfo.outputPath(`${name}-${theme}.png`),
    });
  }
}
