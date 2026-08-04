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
  assert.equal(plan.forceFull, false);
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

test("missing or unresolvable comparisons fail closed to full verification", () => {
  const missing = createCiVerificationPlan({ eventName: "workflow_dispatch" });
  assert.equal(missing.useAffected, false);
  assert.equal(missing.forceFull, true);
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

test("cache-policy changes force complete uncached verification", () => {
  const plan = createCiVerificationPlan({
    afterSha: headSha,
    beforeSha: baseSha,
    eventName: "push",
    runGit: () => ok(".github/workflows/ci.yml\n"),
  });

  assert.equal(plan.cachePolicyChanged, true);
  assert.equal(plan.useAffected, false);
  assert.equal(plan.forceFull, true);
  assert.equal(plan.tinybird, true);
  assert.equal(plan.d1, true);
});

test("cache-policy-only changes force the Turbo graph without unrelated validators", () => {
  const plan = createCiVerificationPlan({
    afterSha: headSha,
    beforeSha: baseSha,
    eventName: "push",
    runGit: () => ok("scripts/check-turbo-remote-cache-env.mjs\n"),
  });

  assert.equal(plan.cachePolicyChanged, true);
  assert.equal(plan.useAffected, false);
  assert.equal(plan.forceFull, true);
  assert.equal(plan.tinybird, false);
  assert.equal(plan.d1, false);
});

test("Tinybird, D1, and production Vite inputs are classified independently", () => {
  assert.deepEqual(classifyCiChanges(["infra/tinybird/pipes/example.pipe"]), {
    cachePolicyChanged: false,
    d1: false,
    productionVite: false,
    tinybird: true,
  });
  assert.deepEqual(classifyCiChanges(["packages/db/migrations/0017_example.sql"]), {
    cachePolicyChanged: false,
    d1: true,
    productionVite: false,
    tinybird: false,
  });
  assert.equal(classifyCiChanges(["packages/ui/src/button.tsx"]).productionVite, true);
});

function ok(stdout) {
  return { ok: true, stderr: "", stdout };
}
