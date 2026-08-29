#!/usr/bin/env node
// Pre-commit guard: no raster images in the repository.
//
// Screenshots are build output. Playwright already writes them to the
// gitignored `test-results/` via `testInfo.outputPath()`, and a PR that needs
// to show one attaches it to the PR or the tracker issue, where it is reviewed
// once and then ages out. Committing them instead makes every clone carry the
// bytes forever: `docs/review/` reached 1.9MB of screenshots from four tickets
// before this guard existed, all of it dead within a week of the merge.
//
// Vector assets (.svg) are source and stay allowed — the brand marks are SVG.

import { execFileSync } from "node:child_process";

const RASTER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"];

function stagedFiles() {
  const records = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    { encoding: "utf8" },
  );
  return records.split("\0").filter(Boolean);
}

const offenders = stagedFiles().filter((file) =>
  RASTER_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)),
);

if (offenders.length > 0) {
  console.error(`\n✖ Binary-asset guard: ${offenders.length} raster image(s) staged.`);
  for (const file of offenders) {
    console.error(`  ${file}`);
  }
  console.error(
    "\nScreenshots and other rasters do not belong in git. Playwright writes\n" +
      "captures to the gitignored test-results/ directory — use\n" +
      "`testInfo.outputPath(name)`, never a hardcoded repo path. To show a\n" +
      "reviewer an image, attach it to the pull request or the tracker issue.\n" +
      "Source vectors (.svg) are unaffected.\n",
  );
  process.exit(1);
}
