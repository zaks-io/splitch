import { describe, expect, it } from "vitest";
import {
  conditionWithOperator,
  emptySegmentDraft,
  emptyValueEntry,
  formatConditionSummary,
  forcedValueType,
  segmentCreateInput,
  segmentDraft,
  segmentDraftIssues,
  segmentUpdateInput,
} from "#lib/segments/segment-form-model";

describe("Segment draft validation", () => {
  it("requires a name, attributes, and non-blank values on present Conditions", () => {
    expect(segmentDraftIssues(emptySegmentDraft())).toEqual([
      { path: "name", message: "Enter a Segment name." },
      { path: "conditions.0.attribute", message: "Enter an attribute." },
      { path: "conditions.0.value", message: "Enter a value." },
    ]);
  });

  it("refuses blank scalar and blank list entries, and non-finite numbers", () => {
    expect(
      segmentDraftIssues({
        name: "Blank",
        description: "",
        conditions: [
          {
            key: "c1",
            attribute: "plan",
            operator: "eq",
            values: [{ key: "v1", text: "", type: "string" }],
          },
        ],
      }),
    ).toEqual([{ path: "conditions.0.value", message: "Enter a value." }]);
    expect(
      segmentDraftIssues({
        name: "Blank list",
        description: "",
        conditions: [
          {
            key: "c1",
            attribute: "country",
            operator: "in",
            values: [
              { key: "v1", text: "US", type: "string" },
              { key: "v2", text: "", type: "string" },
            ],
          },
        ],
      }),
    ).toEqual([{ path: "conditions.0.value", message: "Enter a value." }]);
    expect(
      segmentDraftIssues({
        name: "Bad number",
        description: "",
        conditions: [
          {
            key: "c1",
            attribute: "age",
            operator: "gte",
            values: [{ key: "v1", text: "eighteen", type: "number" }],
          },
        ],
      }),
    ).toEqual([{ path: "conditions.0.value", message: "Enter a number." }]);
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
});

describe("Segment draft emit and round-trip", () => {
  it("emits number and boolean Condition values from the authored form model", () => {
    expect(
      segmentCreateInput({
        name: "Numeric and boolean",
        description: "",
        conditions: [
          {
            key: "c1",
            attribute: "age",
            operator: "gte",
            values: [{ key: "v1", text: "18", type: "number" }],
          },
          {
            key: "c2",
            attribute: "pro",
            operator: "eq",
            values: [{ key: "v2", text: "true", type: "boolean" }],
          },
        ],
      }),
    ).toEqual({
      name: "Numeric and boolean",
      conditions: [
        { attribute: "age", operator: "gte", value: 18 },
        { attribute: "pro", operator: "eq", value: true },
      ],
    });
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
        { attribute: "epsilon", operator: "eq", value: 1e-7 },
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
      { attribute: "epsilon", operator: "eq", value: 1e-7 },
    ]);
  });

  it("keeps values when the operator stays the same shape and coerces forced types", () => {
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
    expect(conditionWithOperator(draft, "gte")).toMatchObject({
      operator: "gte",
      values: [{ text: "paid", type: "number" }],
    });
    expect(forcedValueType("gte")).toBe("number");
    expect(forcedValueType("matches")).toBe("string");
    expect(forcedValueType("eq")).toBeNull();
    expect(emptyValueEntry("number")).toMatchObject({ text: "", type: "number" });
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
