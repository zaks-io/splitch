import { EventDefinitionHotConfigSchema, MetricEventTrackRequestSchema } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { hotConfig, metricEventBody } from "./metric-event.test-fixture";
import { schemaMismatch } from "./metric-event-admission";

const REQUIRED_INTERNAL = {
  fields: [
    { name: "converted", type: "boolean", required: true },
    { name: "internal_purchase_limit", type: "boolean", required: true },
  ],
  dimensions: [],
} as const;

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

describe("schemaMismatch public vs trusted", () => {
  it("enumerates public schema mismatch shapes including missing-required and type-invalid", async () => {
    expect(await publicMismatchBodies()).toMatchInlineSnapshot(`
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
                  "converted",
                ],
              },
            ],
          },
          "message": "Metric Event does not match the Event Definition Version",
        },
      ]
    `);
  });

  it("never leaks configured names, types, bounds, or Event Definition IDs", async () => {
    const [entity, bounds, ...rest] = await publicMismatchBodies();
    for (const raw of [entity, bounds, ...rest].map((body) => JSON.stringify(body))) {
      expect(raw).not.toContain("edv_1");
      expect(raw).not.toContain("ed_signed_up");
      expect(raw).not.toContain("expectedIdType");
      expect(raw).not.toContain("number must be at least");
      expect(raw).not.toContain("number must be at most");
      expect(raw).not.toContain("expected Entity type");
      expect(raw).not.toContain("expected boolean");
      expect(raw).not.toContain("internal_purchase_limit");
      expect(raw).not.toContain("required value is missing");
      expect(raw).not.toContain('"pro"');
      expect(raw).not.toContain('"free"');
    }
    expect(JSON.stringify(entity)).not.toContain("user");
    expect(JSON.stringify(bounds)).not.toContain("10");
    expect(JSON.stringify(bounds)).not.toContain("100");
  });

  it("keeps Event Definition diagnostics on the trusted path", async () => {
    const silent = () => undefined;
    const entity = await jsonOf(
      schemaMismatch(track({ idType: "workspace" }), hot(), "trusted", silent),
    );
    const bounds = await jsonOf(
      schemaMismatch(
        track({ fields: { amount: 5 }, dimensions: {} }),
        hot(BOUNDED_AMOUNT),
        "trusted",
        silent,
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

async function publicMismatchBodies(): Promise<unknown[]> {
  const silent = () => undefined;
  return [
    await jsonOf(schemaMismatch(track({ idType: "workspace" }), hot(), "public", silent)),
    await jsonOf(
      schemaMismatch(
        track({ fields: { amount: 5 }, dimensions: {} }),
        hot(BOUNDED_AMOUNT),
        "public",
        silent,
      ),
    ),
    await jsonOf(
      schemaMismatch(
        track({ fields: { converted: true, profile: "forbidden" } }),
        hot(),
        "public",
        silent,
      ),
    ),
    await jsonOf(
      schemaMismatch(track({ dimensions: { plan: "enterprise" } }), hot(), "public", silent),
    ),
    await jsonOf(
      schemaMismatch(
        track({ fields: { converted: true }, dimensions: {} }),
        hot(REQUIRED_INTERNAL),
        "public",
        silent,
      ),
    ),
    await jsonOf(schemaMismatch(track({ fields: { converted: "yes" } }), hot(), "public", silent)),
  ];
}

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
