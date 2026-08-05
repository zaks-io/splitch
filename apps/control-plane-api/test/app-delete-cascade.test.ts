import type { ErrorResponse, ResourceDeleteResponse } from "@splitch/contracts";
import { appScope, createRepository, envScope } from "@splitch/db";
import type { RateLimiter } from "@splitch/worker-runtime";
import type { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { makeControlPlaneAuthResolver } from "../src/auth-resolver";
import { type FixtureSigner, makeFixtureSigner } from "../src/fixture-signer";
import { makeJwksVerifier } from "../src/jwks-verify";
import { makeSessionStore } from "../src/session-store";
import type { LocalBindings } from "../src/test-fixtures";
import { seedOrgApp, seedOrgMember } from "../src/test-seeds";
import { makePoolBindings as makeLocalBindings } from "./pool-bindings";

/**
 * SPL-326: apps delete --dry-run / --force and RESOURCE_NOT_EMPTY blocker trees.
 */

const AUDIENCE = "https://cp.splitch.test";
const NOW_MS = Date.UTC(2026, 7, 5, 12, 0, 0);
const NOW_ISO = new Date(NOW_MS).toISOString();
const ORG = {
  orgId: "org_app_delete_cascade",
  orgName: "App Delete Cascade Co",
  appId: "app_existing_delete_cascade",
  appName: "Existing Delete Cascade App",
  appKey: "existing-delete-cascade",
};
const OWNER = "user_app_delete_cascade_owner";

const allowLimiter: RateLimiter = () => ({ limited: false });
const nowSeconds = () => Math.floor(NOW_MS / 1000);

interface Harness {
  app: Hono;
  signer: FixtureSigner;
  bindings: LocalBindings;
}

let h: Harness;

beforeAll(async () => {
  const bindings = await makeLocalBindings();
  await seedOrgApp(bindings.d1, ORG);
  await seedOrgMember(bindings.d1, {
    orgId: ORG.orgId,
    userId: OWNER,
    role: "owner",
  });
});

beforeEach(async () => {
  const bindings = await makeLocalBindings();
  const signer = await makeFixtureSigner();
  const verifier = makeJwksVerifier({
    fetchJwks: async () => signer.jwks,
    controlPlaneAudience: AUDIENCE,
  });
  h = {
    app: createApp({
      authResolver: makeControlPlaneAuthResolver({
        verifier,
        sessions: makeSessionStore(bindings.kv),
        now: () => NOW_MS,
      }),
      rateLimiter: allowLimiter,
      repo: createRepository(bindings.d1),
      credentialStore: bindings.credentialKv,
      nowIso: () => NOW_ISO,
    }),
    signer,
    bindings,
  };
});

afterEach(async () => h.bindings.dispose());

async function appToken(appId: string): Promise<string> {
  return h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`app:${appId}:owner`],
  });
}

async function createDefaultApp(suffix: string) {
  const jwt = await h.signer.sign({
    sub: OWNER,
    iss: "https://auth.splitch.test",
    aud: AUDIENCE,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    scopes: [`org:${ORG.orgId}:owner`],
  });
  const res = await h.app.request(`/orgs/${ORG.orgId}/apps`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "idempotency-key": `create_${suffix}`,
    },
    body: JSON.stringify({ name: `Cascade ${suffix}`, key: `cascade-${suffix}` }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    app: { id: string };
    environments: Array<{ id: string; key: string }>;
  };
}

async function seedChildren(appId: string, environmentId: string, suffix: string) {
  const repo = createRepository(h.bindings.d1);
  const flagId = `flag_cascade_${suffix}`;
  await repo.flags.flags.insert(appScope(appId), {
    id: flagId,
    appId,
    key: `cascade-${suffix}`,
    name: "Cascade flag",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.flags.flagConfigs.insert(envScope(appId, environmentId), {
    id: `cfg_cascade_${suffix}`,
    appId,
    environmentId,
    flagId,
    enabled: false,
    availableVariantNames: "[]",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  await repo.experiments.metrics.insert(appScope(appId), {
    id: `metric_cascade_${suffix}`,
    appId,
    key: `cascade-metric-${suffix}`,
    name: "Cascade metric",
    kind: "binomial",
    eventName: "purchase",
    eventValueField: null,
    denominatorMetricId: null,
    createdAt: NOW_ISO,
  });
  await repo.experiments.experiments.insert(envScope(appId, environmentId), {
    id: `exp_cascade_${suffix}`,
    appId,
    environmentId,
    key: `cascade-exp-${suffix}`,
    flagId,
    name: "Cascade experiment",
    status: "ended",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    metrics: "[]",
    guardrailMetrics: "[]",
    dimensions: "[]",
    liveRunId: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  });
  return { flagId, metricId: `metric_cascade_${suffix}`, experimentId: `exp_cascade_${suffix}` };
}

describe("apps delete dry-run and force (SPL-326)", () => {
  it("dry-run lists every blocker with IDs and CLI remove commands without deleting", async () => {
    const created = await createDefaultApp("dry");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const seeded = await seedChildren(created.app.id, prod?.id ?? "", "dry");
    const jwt = await appToken(created.app.id);

    const res = await h.app.request(`/apps/${created.app.id}?dryRun=true`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourceDeleteResponse;
    expect(body).toMatchObject({ deleted: false, dryRun: true });
    if (!("dryRun" in body) || !body.dryRun) {
      throw new Error("expected dry-run response");
    }
    const childTypes = body.blockers.map((b) => b.childType);
    expect(childTypes).toContain("experiments");
    expect(childTypes).toContain("flag-config");
    expect(childTypes).toContain("flags");
    expect(childTypes).toContain("metrics");
    const experiment = body.blockers.find((b) => b.childType === "experiments");
    expect(experiment?.children[0]).toMatchObject({
      id: seeded.experimentId,
      removeCommand: expect.stringContaining("splitch experiments delete"),
    });
    const flagConfig = body.blockers.find((b) => b.childType === "flag-config");
    expect(flagConfig?.children[0]?.removeCommand).toContain(
      `splitch flags delete --app ${created.app.id} ${seeded.flagId}`,
    );

    const stillThere = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(stillThere.status).toBe(200);
  });

  it("RESOURCE_NOT_EMPTY reports all blockers with CLI vocabulary and IDs", async () => {
    const created = await createDefaultApp("empty-err");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const seeded = await seedChildren(created.app.id, prod?.id ?? "", "empty");
    const jwt = await appToken(created.app.id);

    const res = await h.app.request(`/apps/${created.app.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(409);
    const error = (await res.json()) as ErrorResponse;
    expect(error.code).toBe("RESOURCE_NOT_EMPTY");
    expect(error.details).toMatchObject({
      attemptedOp: "DELETE_APP",
      childType: "experiments",
    });
    if (error.code !== "RESOURCE_NOT_EMPTY" || !error.details.blockers) {
      throw new Error("expected blockers on RESOURCE_NOT_EMPTY");
    }
    expect(error.details.blockers.length).toBeGreaterThan(1);
    expect(error.details.blockers.some((b) => b.childType === "flag-config")).toBe(true);
    expect(error.details.blockers.some((b) => b.childType === "metrics")).toBe(true);
    expect(
      error.details.blockers
        .flatMap((b) => b.children)
        .some((c) => c.id === seeded.flagId || c.removeCommand.includes(seeded.flagId)),
    ).toBe(true);
  });

  it("force cascades non-gated children and deletes the App when Policy allows", async () => {
    const created = await createDefaultApp("force-ok");
    const dev = created.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    // Seed only under allow-policy Environment so Flag delete is not gated.
    await seedChildren(created.app.id, dev?.id ?? "", "forceok");
    // Remove the prod flag-config seed side-effect: seedChildren only writes one env.
    const jwt = await appToken(created.app.id);

    const res = await h.app.request(`/apps/${created.app.id}?force=true`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourceDeleteResponse;
    expect(body).toMatchObject({ deleted: true, force: true });
    if (!("force" in body) || !body.force || !body.deleted) {
      throw new Error("expected force completed response");
    }
    expect(body.removed.some((r) => r.childType === "apps" && r.id === created.app.id)).toBe(true);

    const gone = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(gone.status).toBe(404);
  });

  it("force stops with pending Approval Request IDs under confirm Policy", async () => {
    const created = await createDefaultApp("force-apr");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const seeded = await seedChildren(created.app.id, prod?.id ?? "", "forceapr");
    const jwt = await appToken(created.app.id);

    const res = await h.app.request(`/apps/${created.app.id}?force=true`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResourceDeleteResponse;
    expect(body).toMatchObject({ deleted: false, force: true });
    if (!("pendingApprovals" in body)) {
      throw new Error("expected force-blocked response");
    }
    expect(body.pendingApprovals.length).toBeGreaterThan(0);
    expect(body.pendingApprovals[0]?.targetId).toBe(seeded.flagId);
    expect(body.pendingApprovals[0]?.reviewCommand).toContain(
      "splitch approval-request-reviews create",
    );
    expect(body.removed.some((r) => r.childType === "experiments")).toBe(true);

    const retry = await h.app.request(`/apps/${created.app.id}?force=true`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as ResourceDeleteResponse;
    if (!("pendingApprovals" in retryBody)) {
      throw new Error("expected force-blocked retry response");
    }
    expect(retryBody.pendingApprovals[0]?.approvalRequestId).toBe(
      body.pendingApprovals[0]?.approvalRequestId,
    );

    const stillThere = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(stillThere.status).toBe(200);
  });

  it("rejects dryRun and force together", async () => {
    const created = await createDefaultApp("both");
    const jwt = await appToken(created.app.id);
    const res = await h.app.request(`/apps/${created.app.id}?dryRun=true&force=true`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as ErrorResponse).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
