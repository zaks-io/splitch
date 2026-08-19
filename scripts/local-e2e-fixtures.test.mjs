import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_E2E_ANALYSIS_INPUTS } from "./local-e2e-analysis-inputs.mjs";
import {
  LOCAL_E2E_D1_SEED,
  LOCAL_E2E_FIXTURE_CONTRACT,
  LOCAL_E2E_MEMBER_PROFILES,
  LOCAL_E2E_MEMBER_SESSION_KEY,
  LOCAL_E2E_PROFILELESS_USER_ID,
  LOCAL_E2E_RECRUIT_USER_ID,
  LOCAL_E2E_SESSION_KEY,
  localE2eMemberSession,
  localE2eSession,
  memberProfileKey,
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

/**
 * A seeded membership without a profile proves the normal pre-login state. The
 * roster must keep that row without fabricating an email.
 */
test("the roster fixture includes exactly one member without a cached profile", () => {
  const membershipsInsert = LOCAL_E2E_D1_SEED.match(/INSERT INTO org_memberships[^;]*;/)?.[0];
  assert.ok(membershipsInsert, "the seed must insert Org memberships");
  const seededUserIds = [...membershipsInsert.matchAll(/\('org_\w+', '(user_\w+)'/g)].map(
    ([, userId]) => userId,
  );
  assert.ok(seededUserIds.length >= 3);

  const withoutProfiles = seededUserIds.filter((userId) => !LOCAL_E2E_MEMBER_PROFILES[userId]);
  assert.deepEqual(withoutProfiles, [LOCAL_E2E_PROFILELESS_USER_ID]);
  // The person the Members screen adds must start outside every Organization.
  assert.equal(seededUserIds.includes(LOCAL_E2E_RECRUIT_USER_ID), false);
  assert.ok(LOCAL_E2E_MEMBER_PROFILES[LOCAL_E2E_RECRUIT_USER_ID]);
  assert.equal(memberProfileKey("user_x"), "member-profile:user_x");
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

  // Keyed by Run, not by Experiment: an Experiment can carry several frozen Runs
  // and each one is its own analysis window.
  const inputByRun = new Map(LOCAL_E2E_ANALYSIS_INPUTS.map((fixture) => [fixture.runId, fixture]));
  assert.equal(inputByRun.size, 7);
  assert.deepEqual(inputByRun.get("run_checkout_dev_e2e")?.counts, {
    control: 10,
    treatment: 10,
  });
  assert.deepEqual(inputByRun.get("run_checkout_prod_e2e")?.counts, {
    control: 19,
    treatment: 1,
  });
  assert.deepEqual(inputByRun.get("run_checkout_significance_e2e")?.decisionFamily, [
    { metric_id: "checkout-conversion", variant: "treatment" },
  ]);
  assert.deepEqual(inputByRun.get("run_checkout_srm_e2e")?.counts, {
    control: 140,
    treatment: 60,
  });
  assert.deepEqual(inputByRun.get("run_checkout_guardrail_e2e")?.guardrailDecisions, [
    {
      metric_id: "checkout-reliability",
      variant: "treatment",
      downside_threshold_pct: -10,
      guardrail_locked_at_run_start: true,
      threshold_locked_at_run_start: true,
    },
  ]);
  assert.equal(inputByRun.get("run_checkout_dev_e2e")?.exposures.length, 20);
  assert.equal(inputByRun.get("run_checkout_prod_e2e")?.exposures.length, 20);
  assert.deepEqual(inputByRun.get("run_checkout_dev_previous_e2e")?.counts, {
    control: 6,
    treatment: 6,
  });
  assert.match(LOCAL_E2E_D1_SEED, /variant_checkout_control_e2e/);
  assert.match(LOCAL_E2E_D1_SEED, /config_checkout_dev_e2e/);
  assert.match(LOCAL_E2E_D1_SEED, /config_checkout_prod_e2e/);
  assert.match(LOCAL_E2E_D1_SEED, /sha256:[0-9a-f]{64}/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_dev_e2e[\s\S]*'running'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_prod_e2e[\s\S]*'running'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_draft_e2e[\s\S]*'draft'/);
  assert.match(LOCAL_E2E_D1_SEED, /experiment_checkout_ended_e2e[\s\S]*'ended'/);
  assert.match(LOCAL_E2E_D1_SEED, /env_checkout_dev_e2e[\s\S]*variantAvailability":"allow"/);
  assert.match(
    LOCAL_E2E_D1_SEED,
    /env_checkout_settings_retry_e2e[\s\S]*variantAvailability":"allow"/,
  );
  assert.match(LOCAL_E2E_D1_SEED, /env_checkout_prod_e2e[\s\S]*variantAvailability":"confirm"/);
});

// A Run freezes the Variant set it allocates over. If that frozen set does not
// contain the Experiment's default Variant, the Run has no baseline to measure
// lift against and every Results read fails loudly. The seed once shared one
// Flag's Variants across five Experiments and hid exactly that.
test("every seeded Run freezes a Variant set containing its Experiment's control", () => {
  const defaultVariantByExperiment = new Map(
    [...LOCAL_E2E_D1_SEED.matchAll(/\('(experiment_\w+)'(?:, '[^']*'){8}, (?:'(\w+)'|NULL),/g)].map(
      ([, experimentId, variantId]) => [experimentId, variantId],
    ),
  );
  assert.ok(defaultVariantByExperiment.size >= 6);

  const runs = [
    ...LOCAL_E2E_D1_SEED.matchAll(
      /\('(run_\w+)', '\w+', '\w+', '(experiment_\w+)'[\s\S]*?'(\[\{"id":[^']*\])'/g,
    ),
  ];
  assert.ok(runs.length >= 6);

  for (const [, runId, experimentId, variantSetJson] of runs) {
    const control = defaultVariantByExperiment.get(experimentId);
    assert.ok(control, `${runId} points at unseeded ${experimentId}`);
    const names = JSON.parse(variantSetJson).map((variant) => variant.id);
    assert.ok(names.includes(control), `${runId} froze a set without ${control}`);
  }
});

// SPL-189: the one seeded Run the Results tab's unresolvable-Control alert is
// proven against. Unlike every other Run above, its frozen control_variant_id
// must NOT resolve inside its own variant_set — that is what makes the failure
// genuine instead of a mocked component state. It also carries the SRM
// fixture's exact imbalance, so this single Run fires both alert cards at once.
test("the integrity fixture Run freezes a Control absent from its own Variant set", () => {
  const runMatch = LOCAL_E2E_D1_SEED.match(
    /\('run_checkout_integrity_e2e', '\w+', '\w+', 'experiment_checkout_integrity_e2e'[\s\S]*?'(\[\{"id":[^']*\])', '([^']+)',/,
  );
  assert.ok(runMatch, "the seed must insert the integrity Run");
  const [, variantSetJson, controlVariantId] = runMatch;
  const variantIds = JSON.parse(variantSetJson).map((variant) => variant.id);
  assert.ok(variantIds.length > 0);
  assert.equal(
    variantIds.includes(controlVariantId),
    false,
    "the integrity Run's frozen Control must be absent from its own Variant set",
  );

  const inputByRun = new Map(LOCAL_E2E_ANALYSIS_INPUTS.map((fixture) => [fixture.runId, fixture]));
  assert.deepEqual(inputByRun.get("run_checkout_integrity_e2e")?.counts, {
    control: 210,
    treatment: 90,
  });
});

/**
 * D1's `runs.decision_family` and Tinybird's `analysis_run_inputs.decision_family`
 * are different columns in different stores that happen to share a name, and they
 * hold different shapes: `MetricRef[]` here, snake_case `DecisionFamilyMember[]`
 * there (pinned by the test above). Three seed Runs held the Tinybird shape in the
 * D1 column. Nothing read it, so nothing complained, until the Setup tab read it
 * and `metricIds` produced `[undefined]` — which fails `isStringArray` and takes
 * the whole Experiment-detail parse down with it, one bad Run at a time.
 */
test("D1 Run decisions hold MetricRef, never the Tinybird stats shape", () => {
  assert.equal(
    LOCAL_E2E_D1_SEED.includes('"metric_id"'),
    false,
    "a D1 seed row holds the Tinybird snake_case decision shape",
  );

  const decisions = [...LOCAL_E2E_D1_SEED.matchAll(/'(\[\{"metricId":[^']*\])'/g)];
  assert.ok(decisions.length >= 6);
  for (const [, json] of decisions) {
    for (const ref of JSON.parse(json)) {
      assert.deepEqual(Object.keys(ref), ["metricId"]);
      assert.equal(typeof ref.metricId, "string");
    }
  }
});
