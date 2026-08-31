import { describe, expect, it, vi } from "vitest";
import {
  canGrantAppAccess,
  createPanelAppSettingsClient,
  type PanelAppSettings,
  PanelAppSettingsSchema,
} from "./panel-app-settings";

const settings: Omit<PanelAppSettings, "candidates"> = {
  app: {
    id: "app_checkout",
    organizationId: "org_acme",
    name: "Checkout",
    key: "checkout",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  },
  viewerRole: "member",
  members: [],
  flags: { items: [], readTruncated: false, readLimit: 200 },
};

describe("Panel App Settings contract", () => {
  it("distinguishes a withheld candidate roster from a visible empty roster", () => {
    const nonGranter = PanelAppSettingsSchema.parse(settings);
    const withheld = PanelAppSettingsSchema.parse({ ...settings, candidatesWithheld: true });
    const empty = PanelAppSettingsSchema.parse({ ...settings, candidates: [] });

    expect(nonGranter).not.toHaveProperty("candidates");
    expect(nonGranter).not.toHaveProperty("candidatesWithheld");
    expect(withheld).not.toHaveProperty("candidates");
    expect(withheld.candidatesWithheld).toBe(true);
    expect(empty.candidates).toEqual([]);
  });

  it("allows only owners and admins to grant App access", () => {
    expect(
      (["owner", "admin", "member"] as const).filter((role) => canGrantAppAccess(role)),
    ).toEqual(["owner", "admin"]);
  });

  it("Reviews Confirmation-gated children and resumes a forced App delete", async () => {
    const requests: Request[] = [];
    let deleteCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input as RequestInfo, init);
      requests.push(incoming);
      if (incoming.method === "POST") return Response.json(appliedDeleteApproval);
      deleteCount += 1;
      return deleteCount === 1
        ? Response.json({
            deleted: false,
            force: true,
            removed: [{ childType: "experiments", id: "exp_checkout" }],
            pendingApprovals: [
              {
                approvalRequestId: appliedDeleteApproval.id,
                operation: "flags_delete",
                targetId: "flag_checkout",
                reviewCommand: "splitch approval-request-reviews create ...",
              },
            ],
          })
        : Response.json({
            deleted: true,
            force: true,
            removed: [{ childType: "apps", id: "app_checkout" }],
          });
    });
    const client = createPanelAppSettingsClient({
      baseUrl: "https://control-plane.test",
      fetch: fetcher,
    });

    await expect(client.deleteApp({ appId: "app_checkout", force: true })).resolves.toEqual({
      ok: true,
      status: 200,
      data: {
        deleted: true,
        force: true,
        removed: [{ childType: "apps", id: "app_checkout" }],
      },
    });
    expect(requests.map(({ method }) => method)).toEqual(["DELETE", "POST", "DELETE"]);
    expect(requests[1]?.url).toContain(
      `/apps/app_checkout/approval-requests/${appliedDeleteApproval.id}/reviews`,
    );
    await expect(requests[1]?.json()).resolves.toMatchObject({
      action: "approve_and_apply",
      idempotency_key: `panel_app_delete_${appliedDeleteApproval.id}`,
    });
  });

  it("returns a typed Review refusal with cumulative partial-delete progress", async () => {
    const reviewRefusal = {
      code: "FORBIDDEN",
      message: "Approval Request review is not permitted",
      details: {},
    };
    const requests: Request[] = [];
    let deleteCount = 0;
    let reviewCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input as RequestInfo, init);
      requests.push(incoming);
      if (incoming.method === "DELETE") {
        deleteCount += 1;
        return Response.json(deleteCount === 1 ? pendingDelete : secondPendingDelete);
      }
      reviewCount += 1;
      return reviewCount === 1
        ? Response.json(appliedDeleteApproval)
        : Response.json(reviewRefusal, { status: 403 });
    });
    const client = createPanelAppSettingsClient({
      baseUrl: "https://control-plane.test",
      fetch: fetcher,
    });

    await expect(client.deleteApp({ appId: "app_checkout", force: true })).resolves.toEqual({
      ok: false,
      status: 403,
      error: reviewRefusal,
      partialDelete: {
        removed: [...pendingDelete.removed, ...secondPendingDelete.removed],
        appliedApprovalRequestIds: [appliedDeleteApproval.id],
      },
    });
    expect(requests.map(({ method }) => method)).toEqual(["DELETE", "POST", "DELETE", "POST"]);
  });

  it("returns partial progress before Reviewing an Approval Request returned after it was applied", async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const incoming = new Request(input as RequestInfo, init);
      requests.push(incoming);
      return incoming.method === "POST"
        ? Response.json(appliedDeleteApproval)
        : Response.json(pendingDelete);
    });
    const client = createPanelAppSettingsClient({
      baseUrl: "https://control-plane.test",
      fetch: fetcher,
    });

    await expect(client.deleteApp({ appId: "app_checkout", force: true })).resolves.toEqual({
      ok: false,
      status: 500,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: `The Control Plane returned Approval Request ${appliedDeleteApproval.id} after Review already applied it.`,
        details: { fault: "panel_app_delete_partial_failure" },
      },
      partialDelete: {
        removed: pendingDelete.removed,
        appliedApprovalRequestIds: [appliedDeleteApproval.id],
      },
    });
    expect(requests.map(({ method }) => method)).toEqual(["DELETE", "POST", "DELETE"]);
  });
});

const targetVersion = `sha256:${"1".repeat(64)}`;
const appliedDeleteApproval = {
  id: "apr_01J00000000000000000000000",
  appId: "app_checkout",
  policyContexts: [
    {
      environmentId: "env_prod",
      changeTypes: ["variant_availability"],
      level: "confirm",
    },
  ],
  operation: "flags_delete",
  target: { type: "flag", id: "flag_checkout", version: targetVersion },
  diff: {
    current: { flagId: "flag_checkout" },
    proposed: {},
    entries: [{ path: "/flagId", operation: "remove", current: "flag_checkout" }],
  },
  status: "applied",
  proposer: { userId: "user_owner", authDoor: "id_jag" },
  proposedAt: "2026-08-31T12:00:00.000Z",
  resolvedAt: "2026-08-31T12:00:01.000Z",
  applicationResult: {
    targetVersion,
    resourceType: "flag",
    resourceId: "flag_checkout",
    appliedAt: "2026-08-31T12:00:01.000Z",
  },
  latestReview: {
    id: "rev_01J00000000000000000000000",
    approvalRequestId: "apr_01J00000000000000000000000",
    action: "approve_and_apply",
    outcome: "applied",
    actor: { userId: "user_owner", authDoor: "id_jag" },
    reviewedAt: "2026-08-31T12:00:01.000Z",
    reason: null,
    idempotencyKey: "panel_app_delete_apr_01J00000000000000000000000",
    resultingTargetVersion: targetVersion,
    error: null,
  },
} as const;

const pendingDelete = {
  deleted: false,
  force: true,
  removed: [{ childType: "experiments", id: "exp_checkout" }],
  pendingApprovals: [
    {
      approvalRequestId: appliedDeleteApproval.id,
      operation: "flags_delete",
      targetId: "flag_checkout",
      reviewCommand: "splitch approval-request-reviews create ...",
    },
  ],
} as const;

const secondPendingDelete = {
  deleted: false,
  force: true,
  removed: [{ childType: "metrics", id: "metric_checkout" }],
  pendingApprovals: [
    {
      approvalRequestId: "apr_01J00000000000000000000001",
      operation: "flags_delete",
      targetId: "flag_recommendations",
      reviewCommand: "splitch approval-request-reviews create ...",
    },
  ],
} as const;
