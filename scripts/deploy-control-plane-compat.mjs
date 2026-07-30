import { spawnSync } from "node:child_process";

const TRANSITION_TTL_SECONDS = 30 * 60;
const environment = process.argv[2];

if (environment !== "production" && environment !== "shared-preview") {
  fail("usage: node scripts/deploy-control-plane-compat.mjs <production|shared-preview>");
}

const expiresAt = Math.floor(Date.now() / 1000) + TRANSITION_TTL_SECONDS;
run(["turbo", "run", "build", "--filter=@splitch/control-plane-api"]);
run([
  "turbo",
  "run",
  "deploy",
  "--only",
  "--filter=@splitch/control-plane-api",
  "--",
  "--env",
  environment,
  "--strict",
  "--var",
  "CONTROL_PANEL_LEGACY_SESSION_MODE:bounded-rollout",
  "--var",
  `CONTROL_PANEL_LEGACY_SESSION_EXPIRES_AT:${expiresAt}`,
]);

function run(args) {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(`deploy-control-plane-compat: ${message}`);
  process.exit(1);
}
