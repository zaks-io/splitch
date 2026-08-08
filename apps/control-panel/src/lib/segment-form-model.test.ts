import { describe, expect, it } from "vitest";
import {
  conditionWithOperator,
  emptySegmentDraft,
  formatConditionSummary,
  segmentCreateInput,
  segmentDraft,
  segmentDraftIssues,
  segmentUpdateInput,
} from "./segment-form-model";

describe("Segment editor model", () => {
  it("requires a name and attributes on present Conditions", () => {
    expect(segmentDraftIssues(emptySegmentDraft())).toEqual([
      { path: "name", message: "Enter a Segment name." },
      { path: "conditions.0.attribute", message: "Enter an attribute." },
    ]);
  });

  it("allows renaming a Segment with zero Conditions or an empty list value", () => {
    expect(
      segmentDraftIssues({
        name: "Renamed",
        description: "",
        conditions: [],
      }),
    ).toEqual([]);
    expect(
      segmentDraftIssues({
        name: "Renamed",
        description: "",
        conditions: [
          {
            key: "c1",
            attribute: "country",
            operator: "in",
            values: [],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("preserves stored Condition value types through an untouched save", () => {
    const draft = segmentDraft({
      id: "segment_1",
      appId: "app_1",
      name: "Fragile",
      conditions: [
        { attribute: "company", operator: "in", value: ["Acme, Inc"] },
        { attribute: "city", operator: "in", value: [" New York "] },
        { attribute: "tier", operator: "in", value: ["", "gold"] },
        { attribute: "code", operator: "eq", value: "007" },
        { attribute: "ratio", operator: "eq", value: "1.0" },
        { attribute: "flag", operator: "eq", value: "true" },
        { attribute: "pad", operator: "eq", value: " AB " },
        { attribute: "tags", operator: "neq", value: ["a", "b"] },
      ],
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    expect(segmentUpdateInput(draft).conditions).toEqual([
      { attribute: "company", operator: "in", value: ["Acme, Inc"] },
      { attribute: "city", operator: "in", value: [" New York "] },
      { attribute: "tier", operator: "in", value: ["", "gold"] },
      { attribute: "code", operator: "eq", value: "007" },
      { attribute: "ratio", operator: "eq", value: "1.0" },
      { attribute: "flag", operator: "eq", value: "true" },
      { attribute: "pad", operator: "eq", value: " AB " },
      { attribute: "tags", operator: "neq", value: ["a", "b"] },
    ]);
  });

  it("keeps values when the operator stays the same shape", () => {
    const draft = {
      key: "c1",
      attribute: "plan",
      operator: "eq" as const,
      values: [{ key: "v1", text: "paid", type: "string" as const }],
    };
    expect(conditionWithOperator(draft, "neq")).toMatchObject({
      operator: "neq",
      values: [{ text: "paid", type: "string" }],
    });
    expect(
      conditionWithOperator(
        { ...draft, operator: "in", values: [{ key: "v1", text: "US", type: "string" }] },
        "not_in",
      ),
    ).toMatchObject({
      operator: "not_in",
      values: [{ text: "US", type: "string" }],
    });
  });

  it("builds create and update bodies from discrete value rows", () => {
    const draft = {
      name: " Paid plan ",
      description: " Active paid accounts ",
      conditions: [
        {
          key: "c1",
          attribute: " plan ",
          operator: "eq" as const,
          values: [{ key: "v1", text: "paid", type: "string" as const }],
        },
        {
          key: "c2",
          attribute: "country",
          operator: "in" as const,
          values: [
            { key: "v2", text: "US", type: "string" as const },
            { key: "v3", text: "CA", type: "string" as const },
          ],
        },
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
    expect(segmentUpdateInput(draft).conditions).toEqual(segmentCreateInput(draft).conditions);
  });

  it("round-trips a Segment into an editable draft without inventing a Condition", () => {
    expect(
      segmentDraft({
        id: "segment_empty",
        appId: "app_1",
        name: "Empty",
        conditions: [],
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
      }).conditions,
    ).toEqual([]);
    expect(formatConditionSummary({ attribute: "plan", operator: "eq", value: "paid" })).toBe(
      "plan equals paid",
    );
  });
});
