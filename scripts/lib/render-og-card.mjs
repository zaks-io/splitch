import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";

// The Open Graph card size. assets/brand/og-card.html pins the same numbers on
// `body`, and apps/marketing/src/routes/__root.tsx declares them to unfurlers.
const OG_CARD_WIDTH = 1200;
const OG_CARD_HEIGHT = 630;

/**
 * Screenshots assets/brand/og-card.html at the Open Graph size.
 *
 * A headless browser rather than ImageMagick text composition: the card has to
 * resolve the same font stack, `text-wrap: balance`, and split-bar gradient the
 * real header uses, and Chromium is already a repo dev dependency.
 *
 * @param sourcePath absolute path to the card HTML
 * @param outputPath absolute path to write the PNG to
 */
export async function renderOgCard(sourcePath, outputPath) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: OG_CARD_WIDTH, height: OG_CARD_HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(sourcePath).href, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);

    // The glyph is a separate file: a card rendered before it decodes is a
    // wordmark with a hole where the mark should be, and nothing downstream
    // would catch it.
    const glyphLoaded = await page.evaluate(() => {
      const image = document.querySelector("img");
      return image !== null && image.complete && image.naturalWidth > 0;
    });
    if (!glyphLoaded) {
      throw new Error(`Brand glyph failed to load in ${sourcePath}`);
    }

    await page.screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}
