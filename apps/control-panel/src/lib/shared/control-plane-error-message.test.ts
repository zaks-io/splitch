import { describe, expect, it } from "vitest";
import { controlPlaneErrorMessage } from "#lib/shared/control-plane-error-message";

describe("controlPlaneErrorMessage", () => {
  it("surfaces the Worker's per-field issues, which are the ones that say what is missing", () => {
    const message = controlPlaneErrorMessage({
      message: "validation failed",
      details: {
        issues: [
          {
            path: ["experiment", "metrics"],
            message: "Add at least one goal Metric before Start.",
          },
          { path: ["body", "sampleSizeLocked"], message: "sampleSizeLocked is required." },
        ],
      },
    });

    expect(message).toBe(
      "Add at least one goal Metric before Start. sampleSizeLocked is required.",
    );
  });

  it("falls back to the envelope message when the refusal carries no issues", () => {
    expect(
      controlPlaneErrorMessage({ message: "another running Experiment controls this Flag" }),
    ).toBe("another running Experiment controls this Flag");
  });

  it("does not invent a message out of malformed issues", () => {
    expect(
      controlPlaneErrorMessage({ message: "validation failed", details: { issues: [null, {}] } }),
    ).toBe("validation failed");
  });
});
