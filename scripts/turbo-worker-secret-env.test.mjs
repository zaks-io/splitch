import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const turboJson = new URL("../turbo.json", import.meta.url);
const workerSecretEnv = [
  "EVALUATION_PRIVACY_SALT",
  "SPLITCH_DEPLOY_GATE_TOKEN",
  "SPLITCH_EVENT_INGEST_TOKEN",
  "TINYBIRD_COPY_TOKEN",
  "TINYBIRD_INGEST_TOKEN",
  "TINYBIRD_RAW_EVALUATIONS_INGEST_TOKEN",
  "TINYBIRD_READ_TOKEN",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "SPLITCH_REQUIRE_WORKER_SECRET_ENV",
];

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
  });
}
