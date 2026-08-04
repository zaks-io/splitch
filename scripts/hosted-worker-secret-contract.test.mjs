import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hostedWorkerSecrets } from "./lib/hosted-worker-secrets.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

for (const [envName, workflowPath] of [
  ["shared-preview", ".github/workflows/deploy-shared-preview.yml"],
  ["production", ".github/workflows/deploy-production.yml"],
]) {
  test(`${envName} workflow wires every required Worker secret`, () => {
    const required = [...hostedWorkerSecrets(repoRoot, envName).keys()];
    const workflow = readFileSync(join(repoRoot, workflowPath), "utf8");

    assert.match(workflow, /^  SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1"$/m);
    const jobEnv = deployJobEnv(workflow);
    for (const name of required) {
      const value = jobEnv.get(name);
      assert.ok(
        value?.includes(`secrets.${name}`) || value?.includes(`vars.${name}`),
        `${envName} workflow must map ${name} from a same-named environment value`,
      );
    }
  });
}

function deployJobEnv(workflow) {
  const lines = workflow.split("\n");
  const deployStart = lines.findIndex((line) => line === "  deploy:");
  assert.notEqual(deployStart, -1, "workflow must have a deploy job");
  const envStart = lines.findIndex((line, index) => index > deployStart && line === "    env:");
  assert.notEqual(envStart, -1, "deploy job must have an env block");

  const values = new Map();
  for (const line of lines.slice(envStart + 1)) {
    if (/^    \S/.test(line)) break;
    const match = /^      ([A-Z][A-Z0-9_]+):\s*(.+)$/.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}
