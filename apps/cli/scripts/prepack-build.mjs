#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("node", ["scripts/build.mjs"], {
  cwd: packageRoot,
  stdio: "inherit",
});

// pnpm pack --dry-run omits postpack, so only npm's real pack/publish lifecycle may mutate.
if (basename(process.env.npm_execpath ?? "").startsWith("npm-cli")) {
  execFileSync("node", ["scripts/sync-pack-manifest.mjs", "strip"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}
