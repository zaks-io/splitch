import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_E2E_ANALYSIS_INPUTS,
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

// The Panel routes on the Organization slug, so a seeded slug that disagrees with
// the contract sends every `/:orgSlug/...` Playwright navigation to a 404 that
// looks like an application bug. The seed once carried an `-e2e` suffix the
// contract and the session blobs did not.
test("seeded Organization slugs match the contract the Panel routes on", () => {
  const organizationsInsert = LOCAL_E2E_D1_SEED.match(/INSERT INTO organizations[^;]*;/)?.[0];
  assert.ok(organizationsInsert, "the seed must insert Organizations");
  const seeded = [...organizationsInsert.matchAll(/\('(org_\w+)', '[^']*', '([^']*)'/g)].map(
    ([, id, slug]) => ({ id, slug }),
  );
  assert.deepEqual(seeded, [
    { id: "org_acme_e2e", slug: "acme-labs" },
    { id: "org_orbit_e2e", slug: "orbit-tools" },
  ]);

  const contract = LOCAL_E2E_FIXTURE_CONTRACT.organization;
  assert.equal(seeded.find(({ id }) => id === contract.id)?.slug, contract.slug);

  // The session blobs carry the slug the Panel resolves scope from; a mismatch
  // there is the same navigation failure by a different route.
  for (const session of [localE2eSession(expiresAt), localE2eMemberSession(expiresAt)]) {
    for (const org of session.orgs) {
      assert.equal(seeded.find(({ id }) => id === org.orgId)?.slug, org.orgSlug);
    }
  }
});

test("fixture App has explicit Environments and Run-scoped Experiment health states", () => {
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

  const inputByExperiment = new Map(
    LOCAL_E2E_ANALYSIS_INPUTS.map((fixture) => [fixture.experimentId, fixture]),
  );
  assert.equal(inputByExperiment.size, 4);
  assert.deepEqual(inputByExperiment.get("experiment_checkout_dev_e2e")?.counts, {
    control: 10,
    treatment: 10,
  });
  assert.deepEqual(inputByExperiment.get("experiment_checkout_prod_e2e")?.counts, {
    control: 19,
    treatment: 1,
  });
  assert.deepEqual(inputByExperiment.get("experiment_checkout_significance_e2e")?.decisionFamily, [
    { metric_id: "checkout-conversion", variant: "treatment" },
  ]);
  assert.deepEqual(inputByExperiment.get("experiment_checkout_guardrail_e2e")?.guardrailDecisions, [
    {
      metric_id: "checkout-reliability",
      variant: "treatment",
      downside_threshold: -10,
      guardrail_locked_at_run_start: true,
      threshold_locked_at_run_start: true,
    },
  ]);
  assert.equal(inputByExperiment.get("experiment_checkout_dev_e2e")?.exposures.length, 20);
  assert.equal(inputByExperiment.get("experiment_checkout_prod_e2e")?.exposures.length, 20);
  assert.match(LOCAL_E2E_D1_SEED, /variant_checkout_control_e2e/);
  assert.match(LOCAL_E2E_D1_SEED, /config_checkout_dev_e2e/);
  assert.match(LOCAL_E2E_D1_SEED, /config_checkout_prod_e2e/);
  assert.match(LOCAL_E2E_D1_SEED, /sha256:[0-9a-f]{64}/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_dev_e2e[\s\S]*'running'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_prod_e2e[\s\S]*'running'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_draft_e2e[\s\S]*'draft'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_ended_e2e[\s\S]*'ended'/);
});
