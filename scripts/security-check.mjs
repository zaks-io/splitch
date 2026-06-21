// Runs a security tool if its binary is on PATH; otherwise warns loudly and
// skips (exit 0) so local hooks stay usable without every contributor
// installing Python/Go tooling. CI installs the tools, so the same checks run
// authoritatively there. Pass --required to fail instead of skip.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
// Required when explicitly flagged or running in CI: a security gate that
// silently skips in CI gives false confidence. Locally it warns and skips so
// contributors are not forced to install Python/Go tooling.
const required = args.includes("--required") || process.env.CI === "true";
const rest = args.filter((a) => a !== "--required");
const [bin, ...binArgs] = rest;

if (!bin) {
  console.error("Usage: security-check.mjs [--required] <bin> [args...]");
  process.exit(2);
}

const found = spawnSync(process.platform === "win32" ? "where" : "command", [
  process.platform === "win32" ? bin : "-v",
  bin,
]);
const onPath =
  found.status === 0 || spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;

if (!onPath) {
  const msg = `security-check: '${bin}' not found on PATH.`;
  if (required) {
    console.error(`${msg} Install it or run in CI. Failing (--required).`);
    process.exit(1);
  }
  console.warn(`\x1b[33m⚠ ${msg} Skipping locally; CI enforces it.\x1b[0m`);
  process.exit(0);
}

const run = spawnSync(bin, binArgs, { stdio: "inherit" });
process.exit(run.status ?? 1);
