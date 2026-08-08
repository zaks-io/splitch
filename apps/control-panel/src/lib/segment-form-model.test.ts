import { describe, expect, it } from "vitest";
import {
  emptySegmentDraft,
  formatConditionSummary,
  segmentCreateInput,
  segmentDraft,
  segmentDraftIssues,
  segmentUpdateInput,
} from "./segment-form-model";

describe("Segment editor model", () => {
  it("requires a name and structurally valid Conditions", () => {
    expect(segmentDraftIssues(emptySegmentDraft())).toEqual([
      { path: "name", message: "Enter a Segment name." },
      { path: "conditions.0.attribute", message: "Enter an attribute." },
      { path: "conditions.0.valueText", message: "Enter a value." },
    ]);
    expect(
      segmentDraftIssues({
        ...emptySegmentDraft(),
        name: "Paid",
        conditions: [{ key: "c1", attribute: "country", operator: "in", valueText: "  ,  " }],
      }),
    ).toEqual([{ path: "conditions.0.valueText", message: "Enter at least one list value." }]);
  });

  it("builds create and update bodies from the draft", () => {
    const draft = {
      name: " Paid plan ",
      description: " Active paid accounts ",
      conditions: [
        { key: "c1", attribute: " plan ", operator: "eq" as const, valueText: "paid" },
        { key: "c2", attribute: "country", operator: "in" as const, valueText: "US, CA" },
      ],
    };
    expect(segmentCreateInput(draft)).toEqual({
      name: "Paid plan",
      description: "Active paid accounts",
      conditions: [
        { attribute: "plan", operator: "eq", value: "paid" },
        { attribute: "country", operator: "in", value: ["US", "CA"] },
      ],
    });
    expect(segmentUpdateInput(draft)).toEqual({
      name: "Paid plan",
      description: "Active paid accounts",
      conditions: [
        { attribute: "plan", operator: "eq", value: "paid" },
        { attribute: "country", operator: "in", value: ["US", "CA"] },
      ],
    });
  });

  it("round-trips a Segment into an editable draft", () => {
    const draft = segmentDraft({
      id: "segment_1",
      appId: "app_1",
      name: "Enterprise",
      description: "Big accounts",
      conditions: [
        { attribute: "plan", operator: "eq", value: "enterprise" },
        { attribute: "country", operator: "in", value: ["US", "CA"] },
      ],
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    expect(draft.name).toBe("Enterprise");
    expect(draft.description).toBe("Big accounts");
    expect(draft.conditions).toHaveLength(2);
    expect(draft.conditions[0]).toMatchObject({
      attribute: "plan",
      operator: "eq",
      valueText: "enterprise",
    });
    expect(draft.conditions[1]).toMatchObject({
      attribute: "country",
      operator: "in",
      valueText: "US, CA",
    });
    expect(formatConditionSummary({ attribute: "plan", operator: "eq", value: "paid" })).toBe(
      "plan equals paid",
    );
  });
});
