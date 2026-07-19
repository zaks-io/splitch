import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_E2E_ANALYSIS_RESULTS,
  LOCAL_E2E_D1_SEED,
  LOCAL_E2E_FIXTURE_CONTRACT,
  LOCAL_E2E_MEMBER_SESSION_KEY,
  LOCAL_E2E_SESSION_KEY,
  localE2eMemberSession,
  localE2eSession,
} from "./local-e2e-fixtures.mjs";

const expiresAt = 2_000_000_000;

test("local full-stack principals are explicit and unambiguous", () => {
  const owner = localE2eSession(expiresAt);
  const member = localE2eMemberSession(expiresAt);

  assert.notEqual(owner.userId, member.userId);
  assert.notEqual(LOCAL_E2E_SESSION_KEY, LOCAL_E2E_MEMBER_SESSION_KEY);
  assert.deepEqual(LOCAL_E2E_FIXTURE_CONTRACT.principals, {
    owner: { userId: owner.userId, orgRole: "owner", appRole: "owner" },
    member: { userId: member.userId, orgRole: "member", appRole: "member" },
  });
  assert.equal(member.orgs.length, 1);
  assert.equal(member.orgs[0]?.orgId, LOCAL_E2E_FIXTURE_CONTRACT.organization.id);
  assert.equal(member.orgs[0]?.orgRole, "member");
  assert.equal(member.orgs[0]?.apps[0]?.role, "member");
  assert.equal(JSON.stringify(owner).includes("environmentId"), false);
  assert.equal(JSON.stringify(member).includes("environmentId"), false);

  assert.match(LOCAL_E2E_D1_SEED, /'org_acme_e2e', 'user_local_member_e2e', 'member'/);
  assert.match(LOCAL_E2E_D1_SEED, /'app_checkout_e2e', 'user_local_member_e2e', 'member'/);
});

test("fixture App has explicit dev and prod Environments with one SRM attention source", () => {
  const environments = LOCAL_E2E_FIXTURE_CONTRACT.app.environments;
  assert.deepEqual(
    environments.map(({ id, key }) => ({ id, key })),
    [
      { id: "env_checkout_dev_e2e", key: "dev" },
      { id: "env_checkout_prod_e2e", key: "prod" },
    ],
  );
  assert.equal(
    environments.some((environment) => "default" in environment),
    false,
  );

  const attention = environments.filter(
    (environment) => environment.attention.state === "attention",
  );
  assert.deepEqual(attention, [
    {
      id: "env_checkout_prod_e2e",
      key: "prod",
      attention: { state: "attention", srm: true, guardrail: false },
    },
  ]);

  const resultByEnvironment = new Map(
    LOCAL_E2E_ANALYSIS_RESULTS.map((fixture) => [fixture.environmentId, fixture]),
  );
  assert.equal(resultByEnvironment.size, 2);
  assert.equal(resultByEnvironment.get("env_checkout_dev_e2e")?.result.srm.srm_is_mismatch, false);
  assert.equal(resultByEnvironment.get("env_checkout_prod_e2e")?.result.srm.srm_is_mismatch, true);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_dev_e2e[\s\S]*'running'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_prod_e2e[\s\S]*'running'/);
});
