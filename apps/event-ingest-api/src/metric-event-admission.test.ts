import { EventDefinitionHotConfigSchema, MetricEventTrackRequestSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { schemaMismatch } from "./metric-event-admission";
import { hotConfig, metricEventBody } from "./metric-event.test-fixture";

const BOUNDED_AMOUNT = {
  fields: [
    {
      name: "amount",
      type: "number",
      required: true,
      numberKind: "amount",
      minimum: 10,
      maximum: 100,
    },
  ],
  dimensions: [],
} as const;

describe("schemaMismatch disclosure", () => {
  it("omits Event Definition IDs, Entity types, and bounds from public responses", async () => {
    const entity = await jsonOf(schemaMismatch(track({ idType: "workspace" }), hot(), "public"));
    const bounds = await jsonOf(
      schemaMismatch(
        track({ fields: { amount: 5 }, dimensions: {} }),
        hot(BOUNDED_AMOUNT),
        "public",
      ),
    );
    const unknown = await jsonOf(
      schemaMismatch(track({ fields: { converted: true, profile: "forbidden" } }), hot(), "public"),
    );
    const allowlist = await jsonOf(
      schemaMismatch(track({ dimensions: { plan: "enterprise" } }), hot(), "public"),
    );

    expect([entity, bounds, unknown, allowlist]).toMatchInlineSnapshot(`
      [
        {
          "code": "ENTITY_TYPE_MISMATCH",
          "details": {
            "receivedIdType": "workspace",
          },
          "message": "Metric Event Entity type does not match the Event Definition Version",
        },
        {
          "code": "EVENT_SCHEMA_MISMATCH",
          "details": {
            "eventName": "signed_up",
            "issues": [
              {
                "message": "number is out of range",
                "path": [
                  "fields",
                  "amount",
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
                "message": "fields key is not declared",
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
                "message": "value is not allowed",
                "path": [
                  "dimensions",
                  "plan",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
      ]
    `);

    const publicBodies = [entity, bounds, unknown, allowlist].map((body) => JSON.stringify(body));
    for (const raw of publicBodies) {
      expect(raw).not.toContain("edv_1");
      expect(raw).not.toContain("ed_signed_up");
      expect(raw).not.toContain("expectedIdType");
      expect(raw).not.toContain("number must be at least");
      expect(raw).not.toContain("number must be at most");
      expect(raw).not.toContain("expected Entity type");
      expect(raw).not.toContain('"pro"');
      expect(raw).not.toContain('"free"');
    }
    expect(JSON.stringify(entity)).not.toContain("user");
    expect(JSON.stringify(bounds)).not.toContain("10");
    expect(JSON.stringify(bounds)).not.toContain("100");
  });

  it("keeps Event Definition diagnostics on the trusted path", async () => {
    const entity = await jsonOf(schemaMismatch(track({ idType: "workspace" }), hot(), "trusted"));
    const bounds = await jsonOf(
      schemaMismatch(
        track({ fields: { amount: 5 }, dimensions: {} }),
        hot(BOUNDED_AMOUNT),
        "trusted",
      ),
    );

    expect(entity).toMatchObject({
      code: "ENTITY_TYPE_MISMATCH",
      details: {
        expectedIdType: "user",
        receivedIdType: "workspace",
        eventDefinitionId: "ed_signed_up",
      },
    });
    expect(bounds).toMatchObject({
      code: "EVENT_SCHEMA_MISMATCH",
      details: {
        eventName: "signed_up",
        eventDefinitionVersionId: "edv_1",
        issues: [{ path: ["fields", "amount"], message: "number must be at least 10" }],
      },
    });
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
