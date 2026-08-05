import type { ErrorResponse, ResourceDeleteResponse } from "@splitch/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type CascadeHarness,
  makeCascadeHarness,
  ORG,
  OTHER,
  seedCascadeTenants,
} from "./app-delete-cascade-fixture";

/** SPL-326: apps delete --dry-run / --force and RESOURCE_NOT_EMPTY blocker trees. */

let h: CascadeHarness;

beforeAll(async () => {
  await seedCascadeTenants();
});

beforeEach(async () => {
  h = await makeCascadeHarness();
});

afterEach(async () => h.bindings.dispose());

describe("apps delete dry-run and RESOURCE_NOT_EMPTY (SPL-326)", () => {
  it("dry-run lists every blocker with IDs and CLI remove commands without deleting", async () => {
    const created = await h.createDefaultApp("dry");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const seeded = await h.seedChildren(created.app.id, prod?.id ?? "", "dry");
    await h.seedPrivacyLedger(created.app.id, ORG.orgId, "dry");
    const jwt = await h.appToken(created.app.id);

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
    expect(childTypes).toContain("segments");
    expect(childTypes).toContain("entity-privacy");
    expect(childTypes).toContain("privacy-requests");
    const experiment = body.blockers.find((b) => b.childType === "experiments");
    expect(experiment?.children[0]).toMatchObject({
      id: seeded.experimentId,
      removeCommand: expect.stringContaining("splitch experiments delete"),
    });
    const segment = body.blockers.find((b) => b.childType === "segments");
    expect(segment?.children[0]).toMatchObject({
      id: seeded.segmentId,
      removeCommand: expect.stringContaining("splitch segments delete"),
    });
    const flagConfig = body.blockers.find((b) => b.childType === "flag-config");
    expect(flagConfig?.children[0]?.removeCommand).toContain(
      `splitch flags delete --app ${created.app.id} ${seeded.flagId}`,
    );
    const entityPrivacy = body.blockers.find((b) => b.childType === "entity-privacy");
    expect(entityPrivacy?.children[0]?.id).toMatch(/^tombstone:/);
    expect(entityPrivacy?.children[0]?.id).not.toContain("hash_");

    const stillThere = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(stillThere.status).toBe(200);
    expect(await h.privacyCounts(created.app.id, ORG.orgId)).toEqual({ entities: 1, requests: 1 });
  });

  it("RESOURCE_NOT_EMPTY reports all blockers with CLI vocabulary and IDs", async () => {
    const created = await h.createDefaultApp("empty-err");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const seeded = await h.seedChildren(created.app.id, prod?.id ?? "", "empty");
    const jwt = await h.appToken(created.app.id);

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
    const totalChildren = error.details.blockers.reduce((sum, b) => sum + b.children.length, 0);
    expect(error.details.childCount).toBe(totalChildren);
    expect(error.details.childCount).toBeGreaterThan(
      error.details.blockers[0]?.children.length ?? 0,
    );
    expect(error.details.blockers.some((b) => b.childType === "flag-config")).toBe(true);
    expect(error.details.blockers.some((b) => b.childType === "metrics")).toBe(true);
    expect(
      error.details.blockers
        .flatMap((b) => b.children)
        .some((c) => c.id === seeded.flagId || c.removeCommand.includes(seeded.flagId)),
    ).toBe(true);
  });

  it("rejects dryRun and force together", async () => {
    const created = await h.createDefaultApp("both");
    const jwt = await h.appToken(created.app.id);
    const res = await h.app.request(`/apps/${created.app.id}?dryRun=true&force=true`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as ErrorResponse).toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("apps delete --force (SPL-326)", () => {
  it("force cascades non-gated children and deletes the App when Policy allows", async () => {
    const created = await h.createDefaultApp("force-ok");
    const dev = created.environments.find((env) => env.key === "dev");
    expect(dev).toBeDefined();
    await h.seedChildren(created.app.id, dev?.id ?? "", "forceok");
    await h.seedPrivacyLedger(created.app.id, ORG.orgId, "forceok");
    const jwt = await h.appToken(created.app.id);

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
    expect(body.removed.some((r) => r.childType === "segments")).toBe(true);
    expect(body.removed.some((r) => r.childType === "metrics")).toBe(true);
    expect(body.removed.some((r) => r.childType === "experiments")).toBe(true);
    expect(body.removed.some((r) => r.childType === "entity-privacy")).toBe(true);
    expect(body.removed.some((r) => r.childType === "privacy-requests")).toBe(true);

    const gone = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(gone.status).toBe(404);
    expect(await h.privacyCounts(created.app.id, ORG.orgId)).toEqual({ entities: 0, requests: 0 });
    expect(await h.privacyCounts(OTHER.appId, OTHER.orgId)).toEqual({ entities: 1, requests: 1 });
  });

  it("force stops with pending Approval Request IDs under confirm Policy", async () => {
    const created = await h.createDefaultApp("force-apr");
    const prod = created.environments.find((env) => env.key === "prod");
    expect(prod).toBeDefined();
    const seeded = await h.seedChildren(created.app.id, prod?.id ?? "", "forceapr");
    await h.seedPrivacyLedger(created.app.id, ORG.orgId, "forceapr");
    const jwt = await h.appToken(created.app.id);

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
    // Force order archives Experiments then stops on Flag Approvals — segments
    // and metrics must still be present so a stopped cascade does not orphan
    // Flag references (SPL-326 review).
    expect(body.removed.some((r) => r.childType === "experiments")).toBe(true);
    expect(body.removed.some((r) => r.childType === "segments")).toBe(false);
    expect(body.removed.some((r) => r.childType === "metrics")).toBe(false);
    expect(body.removed.some((r) => r.childType === "entity-privacy")).toBe(false);
    expect(body.removed.some((r) => r.childType === "privacy-requests")).toBe(false);
    expect(await h.privacyCounts(created.app.id, ORG.orgId)).toEqual({ entities: 1, requests: 1 });
    expect(await h.privacyCounts(OTHER.appId, OTHER.orgId)).toEqual({ entities: 1, requests: 1 });

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
    expect(await h.privacyCounts(created.app.id, ORG.orgId)).toEqual({ entities: 1, requests: 1 });

    const stillThere = await h.app.request(`/apps/${created.app.id}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(stillThere.status).toBe(200);
  });
});
