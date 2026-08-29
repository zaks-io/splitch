import { type ErrorResponse, membershipCacheKey } from "@splitch/contracts";
import { appScope } from "@splitch/db";
import { describe, expect, it } from "vitest";
import { appAdminScope } from "../src/scope-binding";
import {
  ALICE,
  ENV,
  get,
  harness,
  PAYMENTS,
  post,
  token,
  useRevocationHarness,
} from "./auth-membership-revocation-harness";

useRevocationHarness();

describe("membership cache security backstops", () => {
  it("refuses revoked membership on POST Experiment results before Analysis delegation", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);
    expect(await harness().bindings.kv.get(membershipCacheKey(ALICE))).not.toBeNull();

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);

    const refused = await post(
      `/apps/${PAYMENTS.appId}/envs/${ENV}/experiments/experiment_revoked/results`,
      jwt,
      {},
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()) as ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
    expect(harness().analysisFetch).not.toHaveBeenCalled();
  });

  it("refuses revoked membership on POST Flag test evaluation before Evaluation delegation", async () => {
    const jwt = await token(ALICE, [appAdminScope(PAYMENTS.appId)]);
    expect((await get(`/apps/${PAYMENTS.appId}`, jwt)).status).toBe(200);
    expect(await harness().bindings.kv.get(membershipCacheKey(ALICE))).not.toBeNull();

    await harness().repo.identity.deleteAppMembership(appScope(PAYMENTS.appId), ALICE);

    const refused = await post(
      `/apps/${PAYMENTS.appId}/envs/${ENV}/flags/flag_revoked/test-eval`,
      jwt,
      { evaluationContext: { targetingKey: "user_revoked", idType: "user", attributes: {} } },
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()) as ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
    expect(harness().evaluationFetch).not.toHaveBeenCalled();
  });

  it("refuses revoked Organization usage membership despite a warm cache", async () => {
    const jwt = await token(ALICE, [], "membership-wide-read");
    expect((await get(`/orgs/${PAYMENTS.orgId}`, jwt)).status).toBe(200);
    expect(await harness().bindings.kv.get(membershipCacheKey(ALICE))).not.toBeNull();

    await harness().repo.identity.deleteOrgMembership(PAYMENTS.orgId, ALICE);

    const refused = await get(`/orgs/${PAYMENTS.orgId}/usage`, jwt);
    expect(refused.status).toBe(403);
    expect((await refused.json()) as ErrorResponse).toMatchObject({ code: "FORBIDDEN" });
    expect(harness().analysisFetch).not.toHaveBeenCalled();
  });
});
