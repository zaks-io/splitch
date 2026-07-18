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
      message: "Admin role required",
      fields: [],
    });
  });
});
