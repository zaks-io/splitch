#!/usr/bin/env node
// Derives every served brand asset from the two sources in assets/brand/:
// the mark master (splitch-mark.png) and the social card (og-card.html).
//
// The outputs are committed, so nothing in CI or the build runs this. It is
// the record of *how* each variation was produced, so the next size or format
// is a re-run rather than a round of guessing in an image editor. Re-run it
// after touching a source, then commit the diff.
//
// The master stays lossless RGBA. Quantisation happens per output, so error
// never compounds across derivations.
//
// Requires: brew install imagemagick pngquant oxipng

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderOgCard } from "./lib/render-og-card.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const master = resolve(repoRoot, "assets/brand/splitch-mark.png");
const ogCardSource = resolve(repoRoot, "assets/brand/og-card.html");

// Browsers pick 16 or 32 out of a .ico and scale from there; a 48 frame costs
// 9.6KB of uncompressed BMP that nothing on the web reads. Anything that wants
// a large icon gets a PNG.
const ICO_SIZES = "32,16";

// iOS ignores transparency on a home-screen icon and composites onto black,
// which drops cobalt to unreadable. White is the surface the mark was drawn on.
const APPLE_TOUCH_SIZE = 180;
const APPLE_TOUCH_CONTENT = 164;

// Rendered at 24px tall in the site header, so 156 covers 3x displays. Trimmed
// rather than square: padding is the header's job, not the asset's.
const HEADER_MARK_HEIGHT = 156;

// A maskable icon is cropped to whatever shape the launcher wants, so the mark
// has to survive a circle inscribed in the square: 60% keeps it inside the
// 40%-diameter safe zone the spec guarantees.
const MASKABLE_SIZE = 512;
const MASKABLE_CONTENT = Math.round(MASKABLE_SIZE * 0.6);

// Both apps deploy as separate Workers with their own asset bundle, so each
// needs its own copy at the well-known paths browsers probe without a <link>.
// Only the marketing site gets a social card, because the panel is behind
// auth and a card for it would never be unfurled.
const apps = [
  {
    publicDir: "apps/marketing/public",
    manifestName: "splitch",
    ogCard: true,
  },
  {
    publicDir: "apps/control-panel/public",
    manifestName: "splitch Control Panel",
    ogCard: false,
  },
];

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
}

function requireBinary(name) {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`${name} is not installed. Run: brew install imagemagick pngquant oxipng`);
  }
}

function optimise(absolute, { quantise }) {
  if (quantise) {
    // 90-100 keeps the antialiased edges intact; measured RMSE is under 0.05%.
    run("pngquant", [
      "--force",
      "--quality=90-100",
      "--speed",
      "1",
      "--strip",
      "-o",
      absolute,
      absolute,
    ]);
  }
  run("oxipng", ["-o", "max", "-Z", "--strip", "safe", "-a", "-q", absolute]);
}

function absoluteOutput(outputPath) {
  const absolute = resolve(repoRoot, outputPath);
  mkdirSync(dirname(absolute), { recursive: true });
  console.log(`  ${outputPath}`);
  return absolute;
}

/**
 * @param magickArgs conversion applied to the mark master
 * @param quantise   RGBA palette pass; skip it where ImageMagick already
 *                   produced a palette image (an opaque output).
 */
function writeFromMaster(outputPath, magickArgs, { quantise = true } = {}) {
  const absolute = absoluteOutput(outputPath);
  run("magick", [master, ...magickArgs, absolute]);
  if (absolute.endsWith(".png")) {
    optimise(absolute, { quantise });
  }
}

/** Square PNG on transparency, for the manifest's `purpose: "any"` icons. */
function squareIcon(size) {
  return ["-filter", "Lanczos", "-resize", `${size}x${size}`, "-strip"];
}

/** Mark inset on white, for iOS home screens and `purpose: "maskable"`. */
function insetOnWhite(size, content) {
  return [
    "-filter",
    "Lanczos",
    "-resize",
    `${content}x${content}`,
    "-background",
    "white",
    "-gravity",
    "center",
    "-extent",
    `${size}x${size}`,
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-strip",
    "-dither",
    "None",
    "-colors",
    "255",
    "-type",
    "Palette",
  ];
}

function manifest(name) {
  return {
    name,
    short_name: "splitch",
    start_url: "/",
    display: "standalone",
    // The dark neutral surface base. A manifest takes one value, and the mark
    // and the social card are both built against dark.
    background_color: "#0a0c10",
    theme_color: "#0a0c10",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

requireBinary("magick");
requireBinary("pngquant");
requireBinary("oxipng");

for (const app of apps) {
  console.log(app.publicDir);

  // The path crawlers and chat unfurlers probe blind, with no <link> to read.
  writeFromMaster(`${app.publicDir}/favicon.ico`, [
    "-background",
    "none",
    "-define",
    `icon:auto-resize=${ICO_SIZES}`,
  ]);

  writeFromMaster(
    `${app.publicDir}/apple-touch-icon.png`,
    insetOnWhite(APPLE_TOUCH_SIZE, APPLE_TOUCH_CONTENT),
    { quantise: false },
  );

  writeFromMaster(`${app.publicDir}/brand/splitch-mark.png`, [
    "-trim",
    "+repage",
    "-filter",
    "Lanczos",
    "-resize",
    `x${HEADER_MARK_HEIGHT}`,
    "-strip",
  ]);

  writeFromMaster(`${app.publicDir}/icon-192.png`, squareIcon(192));
  writeFromMaster(`${app.publicDir}/icon-512.png`, squareIcon(512));
  writeFromMaster(
    `${app.publicDir}/icon-maskable-512.png`,
    insetOnWhite(MASKABLE_SIZE, MASKABLE_CONTENT),
    { quantise: false },
  );

  writeFileSync(
    absoluteOutput(`${app.publicDir}/site.webmanifest`),
    `${JSON.stringify(manifest(app.manifestName), null, 2)}\n`,
  );

  if (app.ogCard) {
    const card = absoluteOutput(`${app.publicDir}/og-card.png`);
    await renderOgCard(ogCardSource, card);
    optimise(card, { quantise: true });
  }
}
