import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { hostedWorkerSecretUnion } from "./lib/hosted-worker-secrets.mjs";

const turboJson = new URL("../turbo.json", import.meta.url);
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workerSecretEnv = hostedWorkerSecretUnion(repoRoot);

for (const task of [
  "deploy",
  "@splitch/evaluation-api#deploy",
  "deploy:dry-run",
  "@splitch/evaluation-api#deploy:dry-run",
]) {
  test(`${task} passes Worker secret environment through strict Turbo tasks`, async () => {
    const { tasks } = JSON.parse(await readFile(turboJson, "utf8"));
    for (const name of workerSecretEnv) {
      assert.ok(tasks[task].passThroughEnv.includes(name), `${task} must pass ${name}`);
    }
    assert.ok(
      tasks[task].passThroughEnv.includes("SPLITCH_REQUIRE_WORKER_SECRET_ENV"),
      `${task} must pass SPLITCH_REQUIRE_WORKER_SECRET_ENV`,
    );
    assert.ok(
      tasks[task].passThroughEnv.includes("SPLITCH_DEPLOYED_COMMIT_SHA"),
      `${task} must pass SPLITCH_DEPLOYED_COMMIT_SHA`,
    );
  });
}
