import { appScope, envScope } from "@splitch/db";
import type { Principal } from "@splitch/worker-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeCloudflareHandlers } from "./cloudflare-handlers";
import { makeConvexHandlers } from "./convex-handlers";
import { prepareWinnerProposal } from "./experiment-conclusion-proposal";
import { makeExperimentHandlers } from "./experiment-handlers";
import { ids, NOW, temporaryEnvironmentHarness } from "./temporary-environment-test-harness";

let h: Awaited<ReturnType<typeof temporaryEnvironmentHarness>>;
beforeEach(async () => {
  h = await temporaryEnvironmentHarness();
});
afterEach(async () => {
  await h.dispose();
});

it("refuses Experiments and both integration installations before durable state or provider calls", async () => {
  const environment = await (await h.create()).json();
  const principal: Principal = {
    kind: "control-plane-token",
    id: "user_temporary",
    appId: ids.appId,
    orgId: ids.orgId,
    environmentId: environment.id,
    scopes: [`app:${ids.appId}:owner`],
    authDoor: "device_flow",
  };
  const base = { principal, requestId: "kind-refusal", request: new Request("https://test/") };
  const experiment = await makeExperimentHandlers(h).createExperiment({
    ...base,
    input: {
      params: { appId: ids.appId, environmentId: environment.id },
      body: { key: "temporary-experiment" },
    },
  });
  expect((await experiment.json()).code).toBe("ENVIRONMENT_KIND_UNSUPPORTED");
  const keyPrincipal: Principal = { ...principal, kind: "api-key" };
  const convex = await makeConvexHandlers(h).create({
    ...base,
    principal: keyPrincipal,
    input: {
      body: {
        installationId: "install",
        callbackUrl: "https://example.convex.site",
        webhookSecret: "test-placeholder",
      },
    },
  });
  const cloudflare = await makeCloudflareHandlers(h).create({
    ...base,
    principal: keyPrincipal,
    input: {
      body: {
        installationId: "install",
        endpoint: "https://example.workers.dev",
        pushSecret: "test-placeholder",
      },
    },
  });
  for (const response of [convex, cloudflare])
    expect((await response.json()).code).toBe("ENVIRONMENT_KIND_UNSUPPORTED");
  expect(await h.repo.experiments.listExperiments(envScope(ids.appId, environment.id))).toEqual([]);
  expect(await h.repo.convex.listInstallations(envScope(ids.appId, environment.id))).toEqual([]);
  expect(await h.repo.cloudflare.listInstallations(envScope(ids.appId, environment.id))).toEqual(
    [],
  );
});

it("refuses a Conclusion winner target before reading a snapshot or creating approval evidence", async () => {
  const target = await (await h.create()).json();
  const prepared = await prepareWinnerProposal(h.repo, {
    appId: ids.appId,
    environmentId: ids.environmentId,
    experimentId: ids.experimentId,
    experimentFlagId: ids.flagId,
    run: { variantSet: [] },
    conclusionId: "con_temporary",
    requestId: "winner-refusal",
    body: {
      selectedVariant: "treatment",
      expectedResultToken: `sha256:${"0".repeat(64)}`,
      dataWatermark: NOW,
      idempotencyKey: "winner",
      target: {
        environmentId: target.id,
        flagId: ids.flagId,
        expectedConfigVersion: 1,
        proposedConfig: {
          enabled: true,
          availableVariantNames: ["control", "treatment"],
          targetingRules: [],
          rollout: null,
        },
      },
    },
  });
  expect(prepared.ok).toBe(false);
  if (!prepared.ok)
    expect((await prepared.response.json()).code).toBe("ENVIRONMENT_KIND_UNSUPPORTED");
});

it("creates Flags and edits Segments and Variant values while an expired copy retains reference blockers", async () => {
  const target = await (await h.create()).json();
  const scope = appScope(ids.appId);
  await h.repo.flags.addVariant(scope, ids.flagId, {
    id: "var_temporary_only",
    name: "temporary-only",
    value: JSON.stringify("old"),
    createdAt: NOW,
  });
  await h.repo.flags.segments.insert(scope, {
    id: "seg_temporary",
    appId: ids.appId,
    name: "Temporary segment",
    conditions: "[]",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await h.repo.flags.targetingRules.insert(envScope(ids.appId, target.id), {
    id: "rule_temporary_only",
    appId: ids.appId,
    environmentId: target.id,
    flagId: ids.flagId,
    priority: 1,
    conditions: "[]",
    segmentId: "seg_temporary",
    variantId: "var_temporary_only",
    createdAt: NOW,
    updatedAt: NOW,
  });
  h.setTime(target.temporary.expiresAt);
  const created = await h.request("/flags", "POST", {
    appId: ids.appId,
    key: "after-expiry",
    name: "After expiry",
    lifecycleClass: "ops",
    variants: [{ name: "off", value: false, isDefault: true }],
    idempotency_key: "create-after-expiry",
  });
  expect(created.status).toBe(200);
  const flagId = (await created.json()).id;
  expect(await h.repo.flags.getFlagConfig(envScope(ids.appId, target.id), flagId)).toBeNull();
  expect(
    (
      await h.request("/segments/seg_temporary", "PATCH", {
        conditions: [{ attribute: "plan", operator: "eq", value: "new" }],
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await h.request(`/flags/${ids.flagId}/variants/temporary-only`, "PATCH", {
        value: "new",
        idempotency_key: "variant-after-expiry",
      })
    ).status,
  ).toBe(200);
  const refused = await h.request(`/flags/${ids.flagId}/variants/temporary-only`, "DELETE", {
    idempotency_key: "delete-referenced",
  });
  expect(refused.status).toBe(409);
  const refusal = await refused.json();
  expect(refusal.code).toBe("RESOURCE_NOT_EMPTY");
  expect(JSON.stringify(refusal.details)).toContain(target.id);
  expect((await h.request(`/envs/${target.id}`, "DELETE")).status).toBe(200);
  expect(
    (
      await h.request(`/flags/${ids.flagId}/variants/temporary-only`, "DELETE", {
        idempotency_key: "delete-after-teardown",
      })
    ).status,
  ).toBe(200);
});
