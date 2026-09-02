import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The Open Graph card size. assets/brand/og-card.html pins the same numbers on
// `body`, and apps/marketing/src/routes/__root.tsx declares them to unfurlers.
const OG_CARD_WIDTH = 1200;
const OG_CARD_HEIGHT = 630;

// The card renders as a standalone file, so it inherits none of the webfonts
// packages/ui/src/theme.css imports. Left alone it typesets in whatever
// `system-ui` resolves to on the rendering machine: a different face from the
// live site, and a different one again on CI.
const FONT_STYLESHEETS = [
  "@fontsource-variable/inter/opsz.css",
  "@fontsource/ibm-plex-mono/400.css",
];

// Every family the card actually sets type in. `spec` is the shorthand
// `document.fonts.load` wants; `family` is what the assertion looks for.
const REQUIRED_FONTS = [
  { family: "Inter Variable", spec: '700 68px "Inter Variable"' },
  { family: "IBM Plex Mono", spec: '400 20px "IBM Plex Mono"' },
];

// Resolved against packages/ui, the workspace that owns the webfonts.
const requireFromUi = createRequire(new URL("../../packages/ui/package.json", import.meta.url));

/**
 * Fontsource ships `url(./files/...)` relative to its own stylesheet, and an
 * injected <style> resolves those against the page instead. Rewrite them to
 * absolute file: URLs so the faces load wherever the card lives.
 */
async function fontFaceCss() {
  const stylesheets = await Promise.all(
    FONT_STYLESHEETS.map(async (specifier) => {
      const cssPath = requireFromUi.resolve(specifier);
      const css = await readFile(cssPath, "utf8");
      return css.replace(
        /url\((\.\/[^)]+)\)/g,
        (_, relativePath) => `url(${pathToFileURL(resolve(dirname(cssPath), relativePath)).href})`,
      );
    }),
  );
  return stylesheets.join("\n");
}

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
    await page.addStyleTag({ content: await fontFaceCss() });

    // A missing face is invisible in the output: the text still renders, in the
    // wrong typeface, and the card ships off-brand.
    const missingFonts = await page.evaluate(async (required) => {
      await Promise.all(required.map(({ spec }) => document.fonts.load(spec)));
      await document.fonts.ready;
      const loaded = new Set(
        [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
      );
      return required.filter(({ family }) => !loaded.has(family)).map(({ family }) => family);
    }, REQUIRED_FONTS);
    if (missingFonts.length > 0) {
      throw new Error(`Brand fonts failed to load in ${sourcePath}: ${missingFonts.join(", ")}`);
    }

    // Same failure shape for the glyph: a card rendered before it decodes is a
    // wordmark with a hole where the mark should be.
    const brokenImages = await page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .filter((image) => !image.complete || image.naturalWidth === 0)
        .map((image) => image.getAttribute("src") ?? "(no src)"),
    );
    if (brokenImages.length > 0) {
      throw new Error(`Images failed to load in ${sourcePath}: ${brokenImages.join(", ")}`);
    }

    await page.screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}
