import assert from "node:assert/strict";
import test from "node:test";
import { classifyCiChanges, createCiVerificationPlan } from "./plan-ci-verification.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeBaseSha = "c".repeat(40);

test("pull requests use the exact merge base and head for affected verification", () => {
  const calls = [];
  const plan = createCiVerificationPlan({
    baseSha,
    eventName: "pull_request",
    headSha,
    runGit(args) {
      calls.push(args);
      if (args[0] === "merge-base") return ok(mergeBaseSha);
      return ok("docs/vision.md\nCONTEXT.md\n");
    },
  });

  assert.deepEqual(calls, [
    ["merge-base", baseSha, headSha],
    ["diff", "--name-only", mergeBaseSha, headSha],
  ]);
  assert.equal(plan.baseSha, mergeBaseSha);
  assert.equal(plan.headSha, headSha);
  assert.equal(plan.useAffected, true);
  assert.equal(plan.productionVite, false);
});

test("main pushes compare the exact before and after commits", () => {
  const calls = [];
  const plan = createCiVerificationPlan({
    afterSha: headSha,
    beforeSha: baseSha,
    eventName: "push",
    runGit(args) {
      calls.push(args);
      return ok("packages/sdk/src/index.ts\n");
    },
  });

  assert.deepEqual(calls, [["diff", "--name-only", baseSha, headSha]]);
  assert.equal(plan.useAffected, true);
  assert.equal(plan.productionVite, true);
});

test("missing or unresolvable comparisons fail closed to the full cache-first graph", () => {
  const missing = createCiVerificationPlan({ eventName: "workflow_dispatch" });
  assert.equal(missing.useAffected, false);
  assert.equal(missing.tinybird, true);
  assert.equal(missing.d1, true);

  const unresolved = createCiVerificationPlan({
    baseSha,
    eventName: "pull_request",
    headSha,
    runGit: () => ({ ok: false, stderr: "no merge base", stdout: "" }),
  });
  assert.equal(unresolved.useAffected, false);
  assert.match(unresolved.reason, /no merge base/u);
});

test("no change forces an uncached run: the nightly backstop owns staleness proof", () => {
  // SPL-258's cache-policy guard forced a full uncached run on every push of
  // any PR touching ci.yml or the planner, including its own merge commit.
  // That billed the whole suite repeatedly to prove what nightly-verify
  // already proves within 24h, so it was dropped.
  for (const path of [
    ".github/workflows/ci.yml",
    ".github/workflows/nightly-verify.yml",
    "scripts/check-turbo-remote-cache-env.mjs",
    "scripts/plan-ci-verification.mjs",
    "turbo.json",
  ]) {
    const plan = createCiVerificationPlan({
      afterSha: headSha,
      beforeSha: baseSha,
      eventName: "push",
      runGit: () => ok(`${path}\n`),
    });
    assert.equal(plan.useAffected, true, `${path} must stay cache-first`);
    assert.equal("forceFull" in plan, false);
  }
});

test("turbo.json changes stay affected and trigger no validators", () => {
  // turbo.json is part of Turbo's global hash, so an edit already misses every
  // cache entry and re-executes the full graph. The validators never invoke
  // turbo, so it must not trigger them either.
  const plan = createCiVerificationPlan({
    afterSha: headSha,
    beforeSha: baseSha,
    eventName: "push",
    runGit: () => ok("turbo.json\n"),
  });

  assert.equal(plan.useAffected, true);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, false);
});

test("Tinybird, D1, and production Vite inputs are classified independently", () => {
  assert.deepEqual(classifyCiChanges(["infra/tinybird/pipes/example.pipe"]), {
    d1: false,
    productionVite: false,
    tinybird: true,
  });
  assert.deepEqual(classifyCiChanges(["packages/db/migrations/0017_example.sql"]), {
    d1: true,
    productionVite: false,
    tinybird: false,
  });
  assert.equal(classifyCiChanges(["packages/ui/src/button.tsx"]).productionVite, true);
});

test("a lockfile bump revalidates D1 but not Tinybird", () => {
  // `d1:migrate:*` shell out to `pnpm exec wrangler`, so the resolved dependency
  // graph changes what they prove. `tb` is curl-installed and the Tinybird
  // validator imports node builtins only, so a lockfile bump cannot affect it.
  for (const lockfilePath of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const plan = classifyCiChanges([lockfilePath]);
    assert.equal(plan.d1, true, `${lockfilePath} must revalidate D1`);
    assert.equal(plan.tinybird, false, `${lockfilePath} must not revalidate Tinybird`);
  }
});

test("every helper the Tinybird validator imports triggers it", () => {
  for (const helperPath of [
    "scripts/check-tinybird-local.mjs",
    "scripts/lib/tinybird-analysis-scope-proof.mjs",
    "scripts/lib/tinybird-exposure-status-contract.mjs",
    "scripts/lib/tinybird-process.mjs",
    "scripts/lib/tinybird-metric-stub-tripwire.mjs",
    "scripts/lib/tinybird-retained-family-migration-contract.mjs",
    "scripts/machine-lock.mjs",
    "tinybird.config.json",
  ]) {
    assert.equal(classifyCiChanges([helperPath]).tinybird, true, `${helperPath} must trigger`);
  }
});

function ok(stdout) {
  return { ok: true, stderr: "", stdout };
}
