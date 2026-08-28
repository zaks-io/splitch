import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PLACEHOLDER_KV_ID } from "./lib/hosted-bindings.mjs";
import {
  createFixture,
  deployedCommitSha,
  hostedGeneratedConfig,
  readCalls,
  repoRoot,
  runDeploy,
} from "./lib/deploy-vite-worker-test-support.mjs";

test("control-panel deploy scripts use the Vite-aware deploy wrapper", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "apps/control-panel/package.json"), "utf8"),
  );
  const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8"));
  const viteConfig = readFileSync(join(repoRoot, "apps/control-panel/vite.config.ts"), "utf8");

  assert.equal(packageJson.scripts.deploy, "node ../../scripts/deploy-vite-worker-with-sentry.mjs");
  assert.equal(
    packageJson.scripts["deploy:dry-run"],
    "node ../../scripts/deploy-vite-worker-with-sentry.mjs --dry-run",
  );
  assert.deepEqual(turbo.tasks.deploy.dependsOn, ["build"]);
  assert.deepEqual(turbo.globalEnv, ["CI", "NODE_ENV"]);
  assert.equal("env" in turbo.tasks.build, false);
  for (const task of ["@splitch/control-panel#build", "@splitch/marketing#build"]) {
    assert.equal(turbo.tasks[task].env.includes("CLOUDFLARE_ENV"), true);
    assert.equal(turbo.tasks[task].env.includes("SPLITCH_GENERATED_WRANGLER_ENV"), true);
    assert.equal(turbo.tasks[task].outputs.includes(".wrangler/deploy/**"), true);
  }
  for (const name of [
    "SENTRY_DSN",
    "AUTH_API_ORIGIN",
    "AUTH_JWKS_URI",
    "CONTROL_PLANE_ORIGIN",
    "CONTROL_PANEL_DELEGATION_SECRET",
    "TINYBIRD_API_URL",
    "WORKOS_API_KEY",
    "WORKOS_CLIENT_ID",
  ]) {
    assert.equal(
      turbo.tasks["@splitch/control-panel#build"].env.includes(name),
      false,
      `${name} is a runtime input and must not participate in the Control Panel build cache key`,
    );
    assert.equal(
      turbo.globalEnv.includes(name),
      false,
      `${name} must not invalidate every Turbo task`,
    );
  }
  assert.match(viteConfig, /cloudflareEnvironment === "production"/);
  assert.match(viteConfig, /cloudflareEnvironment === "shared-preview"/);
  assert.match(viteConfig, /delete config\.secrets/);
  for (const name of [
    "SPLITCH_PLATFORM_TARGET",
    "SENTRY_RELEASE",
    "SENTRY_RELEASE_BASE",
    "VITE_SENTRY_DSN",
    "VITE_SENTRY_RELEASE",
    "VITE_SPLITCH_PLATFORM_TARGET",
    "CLOUDFLARE_WEB_ANALYTICS_TOKEN",
  ]) {
    assert.equal(
      turbo.tasks["@splitch/control-panel#build"].env.includes(name),
      true,
      `${name} must participate in the Control Panel build cache key`,
    );
  }
  // Both configs import these, so an edit to the production gate has to move
  // the build hash or a stale cached build ships instead.
  for (const task of ["@splitch/control-panel#build", "@splitch/marketing#build"]) {
    assert.ok(
      turbo.tasks[task].inputs.includes("$TURBO_ROOT$/scripts/lib/vite-*.ts"),
      `${task} must hash the shared Vite config helpers`,
    );
  }
  assert.deepEqual(
    turbo.tasks["@splitch/marketing#build"].env,
    turbo.tasks["@splitch/control-panel#build"].env,
  );
  for (const environment of ["production", "shared-preview"]) {
    assert.match(
      rootPackageJson.scripts[`deploy:dry-run:${environment}`],
      new RegExp(`CLOUDFLARE_ENV=${environment} SPLITCH_GENERATED_WRANGLER_ENV=${environment}`),
    );
  }
});

test("deploys the prebuilt generated hosted config without rebuilding it", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production", "--strict"]);

  assert.equal(result.status, 0, result.stderr);

  const calls = readCalls(fixture.callsPath);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["exec", "wrangler", "deploy"]);
  assert.equal(calls[0].cloudflareEnv, "production");
  assert.equal(calls[0].generatedWranglerEnv, "production");
  assert.equal(calls[0].deployedCommitSha, deployedCommitSha);
  assert.equal(calls[0].args.includes("--env"), false);
  assert.equal(calls[0].args.includes(`SPLITCH_DEPLOYED_COMMIT_SHA:${deployedCommitSha}`), true);
});

test("fails before deploy when the generated hosted config keeps placeholder bindings", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: PLACEHOLDER_KV_ID,
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated Wrangler config/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails before deploy when the prebuilt config targets another hosted environment", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      target: "production",
      kvId: "bdfa1197123d4eef945c5a703d63a572",
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run", "--env", "shared-preview"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prebuilt Wrangler config does not match shared-preview/);
  assert.match(result.stderr, /SPLITCH_PLATFORM_TARGET=production/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails before deploy for package deploy invocation without --env when hosted target is selected", () => {
  const fixture = createFixture({
    generatedConfig: hostedGeneratedConfig({
      kvId: PLACEHOLDER_KV_ID,
      d1Id: "f419e372-d548-4afb-966f-40ff298303d8",
    }),
  });

  const result = runDeploy(fixture, ["--dry-run"], { SPLITCH_PLATFORM_TARGET: "production" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /generated Wrangler config/);
  assert.match(result.stderr, /kv_namespaces\.SESSION_STORE\.id/);

  assert.equal(readCalls(fixture.callsPath).length, 0);
});

test("fails loud when the Turborepo build output is missing", () => {
  const fixture = createFixture({});
  const result = runDeploy(fixture, ["--dry-run", "--env", "production"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing prebuilt Wrangler config/);
  assert.match(result.stderr, /Turborepo task/);
  assert.equal(readCalls(fixture.callsPath).length, 0);
});
