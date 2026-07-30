import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const productionBuild = workflow.match(
  /\n {2}warm-production-build-cache:\n([\s\S]*?)\n {2}spec-lint:\n/,
)?.[1];

test("main CI warms the production build cache after verification", () => {
  assert.ok(productionBuild);
  assert.match(productionBuild, /needs: verify/);
  assert.match(
    productionBuild,
    /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.doesNotMatch(productionBuild, /environment: production/);
});

test("production cache warming matches deploy build inputs without deployment credentials", () => {
  assert.ok(productionBuild);
  assert.match(productionBuild, /TURBO_TOKEN: \$\{\{ secrets\.TURBO_TOKEN \}\}/);
  assert.match(productionBuild, /TURBO_TEAM: \$\{\{ vars\.TURBO_TEAM \}\}/);
  assert.match(
    productionBuild,
    /TURBO_REMOTE_CACHE_SIGNATURE_KEY: \$\{\{ secrets\.TURBO_REMOTE_CACHE_SIGNATURE_KEY \}\}/,
  );
  assert.match(productionBuild, /SPLITCH_PLATFORM_TARGET: production/);
  assert.match(productionBuild, /CLOUDFLARE_ENV: production/);
  assert.match(productionBuild, /SPLITCH_GENERATED_WRANGLER_ENV: production/);
  assert.match(productionBuild, /SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
  assert.match(
    productionBuild,
    /run: pnpm turbo run build --filter=@splitch\/control-panel --filter=@splitch\/marketing/,
  );
  assert.match(productionBuild, /run: node scripts\/check-turbo-remote-cache-env\.mjs --required/);
  assert.doesNotMatch(productionBuild, /CLOUDFLARE_API_TOKEN|TB_TOKEN|SENTRY_AUTH_TOKEN/);
  assert.doesNotMatch(productionBuild, /run: .*deploy/);
});

test("verification remains isolated to the pr-ci platform target", () => {
  const verifyJob = workflow.match(
    /\n {2}verify:\n([\s\S]*?)\n {2}warm-production-build-cache:\n/,
  )?.[1];

  assert.ok(verifyJob);
  assert.match(verifyJob, /SPLITCH_PLATFORM_TARGET: pr-ci/);
  assert.doesNotMatch(verifyJob, /SPLITCH_PLATFORM_TARGET: production/);
});
