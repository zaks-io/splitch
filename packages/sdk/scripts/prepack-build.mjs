#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("node", ["scripts/sync-pack-manifest.mjs", "restore"], {
  cwd: packageRoot,
  stdio: "inherit",
});
execFileSync("npx", ["tsup", "--config", "tsup.contract-surface.config.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
});
execFileSync("npx", ["tsup", "--config", "tsup.config.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
});
