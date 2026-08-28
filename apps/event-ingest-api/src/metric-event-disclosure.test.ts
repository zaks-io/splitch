import { EventDefinitionHotConfigSchema, MetricEventTrackRequestSchema } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import type { EventDefinitionMismatchDiagnostic } from "./event-definition-mismatch-diagnostics";
import { hotConfig, metricEventBody } from "./metric-event.test-fixture";
import { schemaMismatch } from "./metric-event-admission";
import { publicValidationIssues } from "./public-schema-mismatch";

const PURCHASE_LIMIT = {
  fields: [
    {
      name: "internal_purchase_limit",
      type: "boolean",
      required: true,
    },
    {
      name: "profile",
      type: "json",
      required: true,
      jsonSchema: {
        type: "object",
        properties: {
          internal_quota: { type: "boolean" },
        },
        required: ["internal_quota"],
        additionalProperties: false,
      },
    },
  ],
  dimensions: [],
} as const;

describe("schemaMismatch caller-owned probes", () => {
  it("omits configured field names and expected types from missing-required, nested-required, and wrong-type probes", async () => {
    const sink = vi.fn();
    const missing = await jsonOf(
      schemaMismatch(track({ fields: {}, dimensions: {} }), hot(PURCHASE_LIMIT), "public", sink),
    );
    const nested = await jsonOf(
      schemaMismatch(
        track({ fields: { internal_purchase_limit: true, profile: {} }, dimensions: {} }),
        hot(PURCHASE_LIMIT),
        "public",
        sink,
      ),
    );
    const wrongType = await jsonOf(
      schemaMismatch(
        track({
          fields: { internal_purchase_limit: "not-a-bool", profile: { internal_quota: true } },
          dimensions: {},
        }),
        hot(PURCHASE_LIMIT),
        "public",
        sink,
      ),
    );

    expect([missing, nested, wrongType]).toMatchInlineSnapshot(`
      [
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "invalid value",
                "path": [
                  "fields",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "invalid value",
                "path": [
                  "fields",
                  "profile",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "invalid value",
                "path": [
                  "fields",
                  "internal_purchase_limit",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
      ]
    `);

    for (const body of [missing, nested]) {
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("internal_purchase_limit");
      expect(raw).not.toContain("internal_quota");
      expect(raw).not.toContain("required value is missing");
      expect(raw).not.toContain("required JSON key is missing");
      expect(raw).not.toContain("expected boolean");
    }
    expect(JSON.stringify(wrongType)).not.toContain("expected boolean");
    expect(JSON.stringify(wrongType)).not.toContain("required value is missing");
  });

  it("maps unknown issue copy to generic public text", () => {
    expect(
      publicValidationIssues(
        [{ path: ["fields", "amount"], message: "secret bound 10 leaked from validator" }],
        track({ fields: { amount: 1 }, dimensions: {} }),
      ),
    ).toEqual([{ path: ["fields", "amount"], message: "invalid value" }]);
  });

  it("retains the full untruncated mismatch in the trusted diagnostic sink", async () => {
    const recorded: EventDefinitionMismatchDiagnostic[] = [];
    await jsonOf(
      schemaMismatch(
        track({ fields: { internal_purchase_limit: "not-a-bool" }, dimensions: {} }),
        hot(PURCHASE_LIMIT),
        "public",
        (diagnostic) => {
          recorded.push(diagnostic);
        },
      ),
    );

    expect(recorded).toHaveLength(1);
    const diagnostic = recorded[0];
    if (!diagnostic) throw new Error("expected a diagnostic");
    const raw = JSON.stringify(diagnostic);
    expect(raw).toContain("internal_purchase_limit");
    expect(raw).toContain("internal_quota");
    expect(raw).toContain("expected boolean");
    expect(raw).toContain("required value is missing");
    expect(raw).not.toMatch(/\.\.\./);
    expect(diagnostic.eventDefinitionId).toBe("ed_signed_up");
    expect(diagnostic.eventDefinitionVersionId).toBe("edv_1");
    expect(diagnostic.eventDefinition).toEqual(hot(PURCHASE_LIMIT).eventDefinition);
    expect(diagnostic.version).toEqual(hot(PURCHASE_LIMIT).version);
    expect(JSON.stringify(diagnostic)).not.toMatch(/\.\.\./);
    expect(diagnostic.originalIssues).toEqual(
      expect.arrayContaining([
        { path: ["fields", "internal_purchase_limit"], message: "expected boolean" },
        { path: ["fields", "profile"], message: "required value is missing" },
      ]),
    );
  });
});

function hot(versionPatch: Record<string, unknown> = {}) {
  return EventDefinitionHotConfigSchema.parse(JSON.parse(hotConfig("edv_1", 1, versionPatch)).data);
}

function track(patch: Record<string, unknown> = {}) {
  return MetricEventTrackRequestSchema.parse(metricEventBody(patch));
}

async function jsonOf(response: Response | null): Promise<unknown> {
  if (response === null) throw new Error("expected a schema mismatch response");
  return response.json();
}
