import { describe, expect, it } from "vitest";
import { getRoute } from "./route-registry";

describe("Approval Request route contracts", () => {
  it("registers conventional list and single reads", () => {
    const list = getRoute("approval_requests_list");
    const get = getRoute("approval_requests_get");

    expect(list).toMatchObject({
      method: "GET",
      path: "/apps/:appId/approval-requests",
      idempotency: "none",
    });
    expect(get).toMatchObject({
      method: "GET",
      path: "/apps/:appId/approval-requests/:id",
      idempotency: "none",
    });
    expect(
      list?.input.safeParse({
        params: { appId: "app_1" },
        query: {
          status: "pending",
          target_kind: "flag_variant",
          environmentId: "env_prod",
          limit: "25",
        },
      }).success,
    ).toBe(true);
    expect(
      get?.input.safeParse({
        params: { appId: "app_1", id: "apr_01J00000000000000000000000" },
      }).success,
    ).toBe(true);
  });

  it("requires idempotency on the Review route", () => {
    const review = getRoute("approval_request_reviews_create");

    expect(review).toMatchObject({
      method: "POST",
      path: "/apps/:appId/approval-requests/:id/reviews",
      idempotency: "required",
    });
    expect(review?.errors).toEqual(
      expect.arrayContaining([
        "APPROVAL_REVIEW_FORBIDDEN",
        "APPROVAL_REQUEST_STALE",
        "APPROVAL_REQUEST_RESOLVED",
        "APPROVAL_APPLICATION_FAILED",
        "IDEMPOTENCY_KEY_CONFLICT",
      ]),
    );
  });

  it.each([
    "flag_variants_update",
    "flag_config_update",
    "flag_targeting_rules_replace",
    "flags_promote",
    "experiments_start",
  ])("marks %s as a required-idempotency Approval write", (operationId) => {
    const route = getRoute(operationId);
    expect(route?.idempotency).toBe("required");
    expect(route?.errors).not.toContain("CONFIRMATION_REQUIRED");
    expect(route?.errors).toContain("APPROVAL_REVIEW_REQUIRED");
    expect(objectShape(route?.output)).toHaveProperty("approvalRequest");
  });
});

function objectShape(schema: unknown): Record<string, unknown> {
  return (schema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
}
