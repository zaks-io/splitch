import { describe, expect, it } from "vitest";
import type { ApiResult } from "./api";
import { mutationErrorSurface } from "./api";

describe("mutation error surfaces", () => {
  it("maps authoritative 400 validation paths to named form fields", () => {
    const result: ApiResult<never> = {
      ok: false,
      status: 400,
      error: {
        code: "VALIDATION_ERROR",
        message: "Flag Configuration is invalid",
        details: {
          issues: [
            { path: ["allocation", "controlVariant"], message: "Choose a control Variant" },
            { path: ["name"], message: "Name is required" },
          ],
        },
      },
    };

    expect(mutationErrorSurface(result)).toEqual({
      kind: "field",
      code: "VALIDATION_ERROR",
      message: "Flag Configuration is invalid",
      fields: [
        {
          field: "allocation.controlVariant",
          code: "VALIDATION_ERROR",
          message: "Choose a control Variant",
        },
        { field: "name", code: "VALIDATION_ERROR", message: "Name is required" },
      ],
    });
  });

  it("returns the 403 tier contract instead of a recoverable form surface", () => {
    const result: ApiResult<never> = {
      ok: false,
      status: 403,
      error: { code: "FORBIDDEN", message: "Admin role required", details: {} },
    };

    expect(mutationErrorSurface(result)).toEqual({
      kind: "tier",
      code: "FORBIDDEN",
      message: "Admin role required",
      fields: [],
    });
  });

  /**
   * SPL-196: this refusal used to flatten into a generic form error, stranding the
   * operator with "conflict" while a real pending Approval Request sat in the audit
   * log. The request id is the actionable part and must survive.
   */
  it("keeps the Approval Request id and Policy context out of the generic bucket", () => {
    const result: ApiResult<never> = {
      ok: false,
      status: 409,
      error: {
        code: "APPROVAL_REVIEW_REQUIRED",
        message: "Approval Request is pending Review",
        details: {
          approvalRequestId: "apr_1",
          status: "pending",
          policyContexts: [
            {
              environmentId: "env_prod",
              changeTypes: ["enabled_state"],
              level: "confirm",
            },
          ],
          recommendedAction: "REVIEW_APPROVAL_REQUEST",
        },
      },
    };

    expect(mutationErrorSurface(result)).toEqual({
      kind: "approval",
      code: "APPROVAL_REVIEW_REQUIRED",
      message: "Approval Request is pending Review",
      approvalRequestId: "apr_1",
      policyContexts: [
        { environmentId: "env_prod", changeTypes: ["enabled_state"], level: "confirm" },
      ],
      fields: [],
    });
  });
});
