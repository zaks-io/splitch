import { describe, expect, it } from "vitest";
import { formatPayload, humanizeLabel, isListEnvelope } from "./format-payload.js";

describe("humanizeLabel", () => {
  it("splits camelCase and snake_case into words", () => {
    expect(humanizeLabel("defaultVariantId")).toBe("Default Variant ID");
    expect(humanizeLabel("p_value")).toBe("P Value");
    expect(humanizeLabel("targeting-key-type")).toBe("Targeting Key Type");
  });

  it("keeps initialisms and unit suffixes readable", () => {
    expect(humanizeLabel("bySdkRuntime")).toBe("By SDK Runtime");
    expect(humanizeLabel("apiKeyId")).toBe("API Key ID");
    expect(humanizeLabel("conversionWindowMs")).toBe("Conversion Window (ms)");
    expect(humanizeLabel("relative_lift_pct")).toBe("Relative Lift (%)");
    expect(humanizeLabel("srm")).toBe("SRM");
  });
});

describe("isListEnvelope", () => {
  it("accepts the shared bounded-read envelope", () => {
    expect(isListEnvelope({ items: [], readLimit: 200, readTruncated: false, cursor: null })).toBe(
      true,
    );
  });

  it("rejects a resource that merely carries an items array", () => {
    expect(isListEnvelope({ items: [{ id: "a" }] })).toBe(false);
  });
});

describe("formatPayload", () => {
  it("renders a flat collection as an aligned table", () => {
    const rendered = formatPayload(
      {
        items: [
          { id: "org_1", name: "Acme", plan: "free" },
          { id: "org_22", name: "Globex", plan: "pro" },
        ],
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      },
      "Orgs",
    );

    expect(rendered).toBe(
      ["ID      NAME    PLAN", "org_1   Acme    free", "org_22  Globex  pro"].join("\n"),
    );
  });

  it("names the resource when a list is empty", () => {
    expect(
      formatPayload({ items: [], readLimit: 200, readTruncated: false, cursor: null }, "API Keys"),
    ).toBe("No API Keys found.");
  });

  it("says a bounded read was truncated without claiming a read order", () => {
    const rendered = formatPayload(
      { items: [{ id: "seg_1" }], readLimit: 200, readTruncated: true, cursor: null },
      "Segments",
    );

    expect(rendered).toContain("Truncated: more than 200 Segments exist; 200 are shown.");
    expect(rendered).not.toContain("newest");
  });

  it("stacks and marks collection items once a row is not flat", () => {
    const rendered = formatPayload(
      {
        items: [
          { id: "seg_1", conditions: [{ attribute: "plan" }] },
          { id: "seg_2", conditions: [{ attribute: "tier" }] },
        ],
        readLimit: 200,
        readTruncated: false,
        cursor: null,
      },
      "Segments",
    );

    expect(rendered).toContain("- ID: seg_1");
    expect(rendered).toContain("- ID: seg_2");
  });

  it("hoists scalars above nested sections and indents the nested block", () => {
    const rendered = formatPayload({
      id: "env_dev",
      key: "dev",
      policy: { enabledState: "allow" },
    });

    expect(rendered).toBe(
      ["ID: env_dev", "Key: dev", "", "Policy", "  Enabled State: allow"].join("\n"),
    );
  });

  it("distinguishes a null field from an empty string", () => {
    expect(formatPayload({ rollout: null, description: "" })).toBe(
      ["Rollout: (none)", "Description: (empty)"].join("\n"),
    );
  });

  it("leaves table cells blank rather than filling a column with (none)", () => {
    const rendered = formatPayload(
      { items: [{ id: "a", rollout: null }], readLimit: 200, readTruncated: false, cursor: null },
      "Flags",
    );

    expect(rendered).toBe(["ID  ROLLOUT", "a"].join("\n"));
  });

  it("joins a short scalar array inline and bullets a list of commands", () => {
    expect(formatPayload({ availableVariantNames: ["on", "off"] })).toBe(
      "Available Variant Names: on, off",
    );
    expect(
      formatPayload({ nextSteps: ["splitch orgs list", 'splitch orgs create --name "<name>"'] }),
    ).toBe(
      ["Next Steps", "- splitch orgs list", '- splitch orgs create --name "<name>"'].join("\n"),
    );
  });

  it("passes a string payload through untouched", () => {
    expect(formatPayload("already prose")).toBe("already prose");
  });
});
