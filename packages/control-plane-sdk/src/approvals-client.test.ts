import { describe, expect, it, vi } from "vitest";
import { createControlPlaneSdk } from "./index";

const request = {
  id: "apr_01J00000000000000000000000",
  appId: "app_checkout",
  policyContexts: [
    {
      environmentId: "env_prod",
      changeTypes: ["enabled_state"],
      level: "confirm",
    },
  ],
  operation: "flag_config_update",
  target: {
    type: "flag_configuration",
    id: "fc_checkout_prod",
    version: `sha256:${"1".repeat(64)}`,
  },
  diff: {
    current: { enabled: false },
    proposed: { enabled: true },
    entries: [{ path: "/enabled", operation: "replace", current: false, proposed: true }],
  },
  status: "pending",
  proposer: { userId: "user_1", authDoor: "id_jag" },
  proposedAt: "2026-07-29T12:00:00.000Z",
  resolvedAt: null,
  applicationResult: null,
  latestReview: null,
} as const;

describe("control plane sdk approvals client", () => {
  it("lists and gets durable Approval Requests", async () => {
    const { sdk, requests } = approvalsSdk((incoming) =>
      Response.json(
        incoming.url.includes("?")
          ? { items: [request], cursor: null, limit: 10, total: 1 }
          : request,
      ),
    );

    const listed = await sdk.approvals.list({
      appId: "app_checkout",
      status: "pending",
      environmentId: "env_prod",
      limit: 10,
      cursor: null,
    });
    const fetched = await sdk.approvals.get({
      appId: "app_checkout",
      id: request.id,
    });

    expect(requests[0]?.url).toContain(
      "/apps/app_checkout/approval-requests?status=pending&environmentId=env_prod&limit=10",
    );
    expect(listed.ok && listed.data.items[0]?.id).toBe(request.id);
    expect(fetched.ok && fetched.data.id).toBe(request.id);
  });

  it("sends the Review idempotency key in both body and header", async () => {
    const { sdk, requests } = approvalsSdk(() => Response.json(request));

    await sdk.approvals.review({
      appId: "app_checkout",
      id: request.id,
      action: "decline",
      reason: "Superseded",
      idempotency_key: "idem_review_sdk",
    });

    expect(requests[0]?.headers.get("idempotency-key")).toBe("idem_review_sdk");
    await expect(requests[0]?.json()).resolves.toEqual({
      action: "decline",
      reason: "Superseded",
      idempotency_key: "idem_review_sdk",
    });
  });
});

function approvalsSdk(response: (request: Request) => Response) {
  const requests: Request[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    requests.push(request);
    return response(request);
  });
  return {
    sdk: createControlPlaneSdk({ baseUrl: "https://control-plane.test", fetch: fetcher }),
    requests,
  };
}
