import assert from "node:assert/strict";
import test from "node:test";
import {
  createFixture,
  hostedGeneratedConfig,
  readCalls,
  runDeploy,
} from "./lib/deploy-vite-worker-test-support.mjs";

// Guards against SPL-208: `wrangler deploy` reads the .wrangler/deploy/config.json
// redirect that @cloudflare/vite-plugin writes to point at the generated
// dist/server/wrangler.json. If Turborepo's build cache restores dist/ without
// restoring that redirect, wrangler silently falls back to the source
// wrangler.jsonc and the deploy fails deep inside esbuild instead of at a named
// guard (ADR-0036, fail loud, no silent fallback).

test("fails loud when the Wrangler deploy redirect is missing", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
    redirect: "missing",
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing Wrangler deploy redirect/);
  assert.match(result.stderr, /Turborepo build task/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails loud when the Wrangler deploy redirect is malformed JSON", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
    redirect: "malformed",
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unparseable Wrangler deploy redirect/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails loud when the Wrangler deploy redirect points at a different config", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
    redirect: { configPath: "../../dist/server/other-wrangler.json", auxiliaryWorkers: [] },
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Wrangler deploy redirect .* points at/);
  assert.match(result.stderr, /other-wrangler\.json/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("deploys when the Wrangler deploy redirect correctly targets the generated config", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
    redirect: "default",
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readCalls(fixture.callsPath).length, 1);
});
