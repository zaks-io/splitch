import { describe, expect, it } from "vitest";
import type { MutationErrorSurface } from "./api";
import { booleanFlagInput, flagFieldError } from "./create-flag-model";

describe("Create Flag model", () => {
  it("builds the zero-JSON boolean catalog with disabled as the Default Variant", () => {
    expect(booleanFlagInput("app_checkout", " new-checkout ")).toEqual({
      appId: "app_checkout",
      key: "new-checkout",
      name: "New Checkout",
      schema: { type: "boolean" },
      variants: [
        { name: "disabled", value: false, isDefault: true },
        { name: "enabled", value: true, isDefault: false },
      ],
    });
  });

  it("places Worker key validation on the key field", () => {
    const error: MutationErrorSurface = {
      kind: "field",
      message: "validation failed",
      fields: [{ field: "body.key", code: "VALIDATION_ERROR", message: "flag key already exists" }],
    };

    expect(flagFieldError(error, "key")).toBe("flag key already exists");
  });
});
