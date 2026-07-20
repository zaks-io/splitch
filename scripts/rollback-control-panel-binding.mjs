import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const environment = process.argv[2];
const environments = new Set(["production", "shared-preview"]);

if (!environments.has(environment)) {
  fail("usage: node scripts/rollback-control-panel-binding.mjs <production|shared-preview>");
}

const controlPanelVersion = requiredVersion("SPLITCH_ROLLBACK_CONTROL_PANEL_VERSION_ID");
const compatDeployScript = fileURLToPath(
  new URL("./deploy-control-plane-compat.mjs", import.meta.url),
);

runNode(compatDeployScript, environment);
deployVersion("apps/control-panel", controlPanelVersion, "Control Panel predecessor rollback");

function deployVersion(directory, version, message) {
  run([
    "--dir",
    directory,
    "exec",
    "wrangler",
    "versions",
    "deploy",
    `${version}@100%`,
    "--env",
    environment,
    "--yes",
    "--message",
    message,
  ]);
}

function requiredVersion(name) {
  const value = process.env[name];
  if (!value || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    fail(`${name} must be a full Worker version ID`);
  }
  return value;
}

function run(args) {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runNode(script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(`rollback-control-panel-binding: ${message}`);
  process.exit(1);
}
