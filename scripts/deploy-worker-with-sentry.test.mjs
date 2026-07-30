import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  createFixture,
  deployedCommitSha,
  readCalls,
  runDeploy,
} from "./lib/deploy-worker-with-sentry-test-support.mjs";
import { PLACEHOLDER_KV_ID } from "./lib/hosted-bindings.mjs";

test("passes required Worker secrets to wrangler deploy as a temporary secrets file", () => {
  const fixture = createFixture({
    requiredSecrets: ["SENTRY_DSN", "SPLITCH_EVENT_INGEST_TOKEN", "TINYBIRD_INGEST_TOKEN"],
  });

  const result = runDeploy(fixture, ["--env", "production", "--strict"], {
    SENTRY_DSN: "https://example.invalid/1",
    SPLITCH_EVENT_INGEST_TOKEN: "fake-event-ingest-token",
    TINYBIRD_INGEST_TOKEN: "fake-ingest-token",
    SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  const secretsFileIndex = call.args.indexOf("--secrets-file");
  assert.notEqual(secretsFileIndex, -1);
  assert.deepEqual(call.args.slice(0, 3), ["exec", "wrangler", "deploy"]);
  assert.equal(call.args.includes(`SPLITCH_DEPLOYED_COMMIT_SHA:${deployedCommitSha}`), true);
  assert.deepEqual(call.args.slice(secretsFileIndex + 2), []);
  assert.deepEqual(Object.keys(call.secrets).sort(), [
    "SENTRY_DSN",
    "SPLITCH_EVENT_INGEST_TOKEN",
    "TINYBIRD_INGEST_TOKEN",
  ]);
  assert.equal(existsSync(call.secretsFile), false);
});

test("omits missing Worker secrets from the deploy secrets file when env values are optional", () => {
  const fixture = createFixture({
    requiredSecrets: ["SENTRY_DSN", "SPLITCH_EVENT_INGEST_TOKEN"],
  });

  const result = runDeploy(fixture, ["--env", "production"], {
    SENTRY_DSN: "https://example.invalid/1",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  const secretsFileIndex = call.args.indexOf("--secrets-file");
  assert.notEqual(secretsFileIndex, -1);
  assert.deepEqual(Object.keys(call.secrets).sort(), ["SENTRY_DSN"]);
  assert.equal(call.secrets.SPLITCH_EVENT_INGEST_TOKEN, undefined);
  assert.equal(existsSync(call.secretsFile), false);
});

test("does not pass Worker secrets during dry-run deploys", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production"], {
    SENTRY_DSN: "https://example.invalid/1",
  });

  assert.equal(result.status, 0, result.stderr);

  const [call] = readCalls(fixture.callsPath);
  assert.equal(call.args.includes("--secrets-file"), false);
});

test("removes the deploy secrets file when wrangler deploy fails", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runDeploy(
    fixture,
    ["--env", "production"],
    { SENTRY_DSN: "https://example.invalid/1" },
    "17",
  );

  assert.equal(result.status, 17);

  const [call] = readCalls(fixture.callsPath);
  assert.equal(existsSync(call.secretsFile), false);
});

test("uploads validated Sentry source maps without waiting for server processing", () => {
  const fixture = createFixture();

  const result = runDeploy(fixture, ["--env", "production"], {
    SENTRY_AUTH_TOKEN: "fake-auth-token",
    SENTRY_ORG: "fake-org",
    SENTRY_PROJECT: "fake-project",
  });

  assert.equal(result.status, 0, result.stderr);

  const calls = readCalls(fixture.callsPath);
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 3)),
    [
      ["exec", "wrangler", "deploy"],
      ["exec", "sentry-cli", "releases"],
      ["exec", "sentry-cli", "sourcemaps"],
    ],
  );
  assert.equal(calls[2].args.includes("--validate"), true);
  assert.equal(calls[2].args.includes("--wait"), false);
  assert.equal(calls[2].args.includes("--wait-for"), false);
});

test("keeps the deploy green and emits an annotation when Sentry reports the prior timeout", () => {
  const fixture = createFixture();

  const result = runDeploy(fixture, ["--env", "production"], {
    SENTRY_AUTH_TOKEN: "fake-auth-token",
    SENTRY_ORG: "fake-org",
    SENTRY_PROJECT: "fake-project",
    CI: "true",
    SPLITCH_FAKE_SENTRY_UPLOAD_EXIT: "1",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Failed to process files in 60s/);
  assert.match(result.stderr, /::warning title=Sentry source map upload failed::/);

  const wranglerDeploys = readCalls(fixture.callsPath).filter(
    (call) => call.args[1] === "wrangler" && call.args[2] === "deploy",
  );
  assert.equal(wranglerDeploys.length, 1);
  assert.equal(wranglerDeploys[0].args.includes("--dry-run"), false);
});

test("fails before wrangler deploy when CI requires a missing Worker secret", () => {
  const fixture = createFixture({ requiredSecrets: ["SENTRY_DSN"] });

  const result = runDeploy(fixture, ["--env", "production"], {
    SPLITCH_REQUIRE_WORKER_SECRET_ENV: "1",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing Worker secret env: SENTRY_DSN/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before wrangler deploy when hosted env bindings contain placeholders", () => {
  const fixture = createFixture({
    bindings: {
      kv_namespaces: [{ binding: "SESSION_STORE", id: PLACEHOLDER_KV_ID }],
    },
  });

  const result = runDeploy(fixture, ["--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wrangler\.jsonc env\.production/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before wrangler deploy when hosted target is implied without a resolved env", () => {
  const fixture = createFixture();

  const result = runDeploy(fixture, ["--dry-run"], {
    SPLITCH_PLATFORM_TARGET: "production",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hosted deploy target production requires --env/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before hosted deploy when the revision is only a workflow ref", () => {
  const fixture = createFixture();

  const result = runDeploy(fixture, ["--env", "production"], {
    SPLITCH_DEPLOYED_COMMIT_SHA: "main",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a full SPLITCH_DEPLOYED_COMMIT_SHA/);
  assert.equal(existsSync(fixture.callsPath), false);
});

test("fails before auth Worker deploy when hosted Control Panel origin is missing", () => {
  const fixture = createFixture({
    workerName: "splitch-auth-api",
    vars: { AUTH_API_ORIGIN: "https://auth.example.test" },
  });

  const result = runDeploy(fixture, ["--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CONTROL_PANEL_ORIGIN/);
  assert.equal(existsSync(fixture.callsPath), false);
});

for (const missingVerifierBinding of ["WORKOS_JWKS_URI", "WORKOS_ISSUER", "WORKOS_CLIENT_ID"]) {
  test(`fails before auth Worker deploy when ${missingVerifierBinding} is not required`, () => {
    const requiredSecrets = ["WORKOS_JWKS_URI", "WORKOS_ISSUER", "WORKOS_CLIENT_ID"].filter(
      (name) => name !== missingVerifierBinding,
    );
    const fixture = createFixture({
      workerName: "splitch-auth-api",
      targetVars: { CONTROL_PANEL_ORIGIN: "https://app.example.test" },
      requiredSecrets,
    });

    const result = runDeploy(fixture, ["--env", "production"]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(missingVerifierBinding));
    assert.equal(existsSync(fixture.callsPath), false);
  });
}
