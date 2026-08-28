import { eventDefinitionConfigKey, ErrorResponseSchema, getRoute } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  hotConfig,
  METRIC_APP_ID,
  METRIC_EVENT_NAME,
  makeMetricEventFixture,
  metricEventBody,
  sendMetricEvent,
} from "./metric-event.test-fixture";

const SDK_TRACK_ERRORS = [...(getRoute("sdk_track")?.errors ?? [])];
const INGEST_OWNED_ERRORS = SDK_TRACK_ERRORS.filter((code) => code !== "ORIGIN_NOT_ALLOWED");

describe("sdk_track public Client Key response shapes", () => {
  it("HTTP-produces every route-contract error plus first/replay success and schema probes", async () => {
    const produced = await producePublicSdkTrackShapes();
    expect(SDK_TRACK_ERRORS).toHaveLength(12);
    expect(SDK_TRACK_ERRORS).toContain("ORIGIN_NOT_ALLOWED");
    expect(Object.keys(produced.errors).sort()).toEqual([...INGEST_OWNED_ERRORS].sort());

    expect(produced.success).toEqual({
      first: {
        accepted: true,
        duplicate: false,
        eventId: "123e4567-e89b-42d3-a456-426614174000",
      },
      replay: {
        accepted: true,
        duplicate: true,
        eventId: "123e4567-e89b-42d3-a456-426614174000",
      },
    });
    expect(produced.probes).toEqual({
      missingRequired: {
        code: "EVENT_SCHEMA_MISMATCH",
        message: "Metric Event does not match the Event Definition Version",
        details: {
          eventName: METRIC_EVENT_NAME,
          issues: [{ path: ["fields"], message: "invalid value" }],
        },
      },
      nestedRequired: {
        code: "EVENT_SCHEMA_MISMATCH",
        message: "Metric Event does not match the Event Definition Version",
        details: {
          eventName: METRIC_EVENT_NAME,
          issues: [{ path: ["fields", "profile"], message: "invalid value" }],
        },
      },
      wrongType: {
        code: "EVENT_SCHEMA_MISMATCH",
        message: "Metric Event does not match the Event Definition Version",
        details: {
          eventName: METRIC_EVENT_NAME,
          issues: [{ path: ["fields", "internal_purchase_limit"], message: "invalid value" }],
        },
      },
    });

    const publicBodies = [
      ...Object.values(produced.errors),
      produced.success.first,
      produced.success.replay,
      ...Object.values(produced.probes),
    ].map((body) => JSON.stringify(body));
    for (const raw of publicBodies) {
      expect(raw).not.toContain("ed_signed_up");
      expect(raw).not.toContain("edv_1");
      expect(raw).not.toContain("eventDefinitionId");
      expect(raw).not.toContain("eventDefinitionVersionId");
      expect(raw).not.toContain("expected boolean");
      expect(raw).not.toContain("required value is missing");
      expect(raw).not.toContain("internal_quota");
    }
    expect(JSON.stringify(produced.probes.missingRequired)).not.toContain(
      "internal_purchase_limit",
    );
    expect(JSON.stringify(produced.probes.nestedRequired)).not.toContain("internal_purchase_limit");
    expect(produced.diagnostic).toContain("internal_purchase_limit");
    expect(produced.diagnostic).toContain("internal_quota");
    expect(produced.diagnostic).toContain("expected boolean");
    expect(produced.diagnostic).toContain("required value is missing");
    expect(produced.diagnostic).not.toMatch(/\.\.\./);
  });
});

async function producePublicSdkTrackShapes() {
  const errors: Record<string, unknown> = {};
  const record = async (code: string, response: Response) => {
    const body = await response.json();
    const parsed = ErrorResponseSchema.parse(body);
    expect(parsed.code).toBe(code);
    errors[code] = parsed;
  };

  await record(
    "UNAUTHORIZED",
    await sendMetricEvent(await makeMetricEventFixture(), metricEventBody(), {
      actorId: "client_key:not-a-hash",
    }),
  );
  await record(
    "CREDENTIAL_REVOKED",
    await sendMetricEvent(
      await makeMetricEventFixture({}, "client_key", { credential: { revoked: true } }),
      metricEventBody(),
    ),
  );
  await record(
    "INSUFFICIENT_SCOPES",
    await sendMetricEvent(
      await makeMetricEventFixture({}, "client_key", {
        credential: { scopes: ["data-plane:evaluate"] },
      }),
      metricEventBody(),
    ),
  );
  await record(
    "VALIDATION_ERROR",
    await sendMetricEvent(
      await makeMetricEventFixture(),
      metricEventBody({ eventId: "not-a-uuid" }),
    ),
  );
  await record(
    "EVENT_DEFINITION_NOT_FOUND",
    await sendMetricEvent(
      await makeMetricEventFixture(),
      metricEventBody({ eventName: "unknown_event" }),
    ),
  );

  const unpublished = await makeMetricEventFixture();
  unpublished.config.set(
    eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
    hotConfig("edv_1", 1, {}, { state: "draft", currentPublishedVersionId: null }),
  );
  await record(
    "EVENT_DEFINITION_UNPUBLISHED",
    await sendMetricEvent(unpublished, metricEventBody()),
  );

  await record(
    "ENTITY_TYPE_MISMATCH",
    await sendMetricEvent(await makeMetricEventFixture(), metricEventBody({ idType: "workspace" })),
  );
  await record("EVENT_ID_CONFLICT", await conflictResponse());
  await record(
    "RATE_LIMITED",
    await sendMetricEvent(
      await makeMetricEventFixture({}, "client_key", {
        admission: { allowed: false, retryAfterMs: 1000 },
      }),
      metricEventBody(),
    ),
  );
  await record(
    "SERVICE_UNAVAILABLE",
    await sendMetricEvent(
      await makeMetricEventFixture({}, "client_key", { omitCredentialStore: true }),
      metricEventBody(),
    ),
  );

  const probeFixture = await makeMetricEventFixture();
  probeFixture.config.set(
    eventDefinitionConfigKey(METRIC_APP_ID, METRIC_EVENT_NAME),
    hotConfig("edv_1", 1, purchaseLimitVersion()),
  );
  const errorsLog: unknown[] = [];
  const error = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorsLog.push(args);
  });
  const missingRequired = ErrorResponseSchema.parse(
    await (
      await sendMetricEvent(probeFixture, metricEventBody({ fields: {}, dimensions: {} }))
    ).json(),
  );
  const nestedRequired = ErrorResponseSchema.parse(
    await (
      await sendMetricEvent(
        probeFixture,
        metricEventBody({
          fields: { internal_purchase_limit: true, profile: {} },
          dimensions: {},
        }),
      )
    ).json(),
  );
  const wrongType = ErrorResponseSchema.parse(
    await (
      await sendMetricEvent(
        probeFixture,
        metricEventBody({
          fields: { internal_purchase_limit: "not-a-bool", profile: { internal_quota: true } },
          dimensions: {},
        }),
      )
    ).json(),
  );
  error.mockRestore();
  errors.EVENT_SCHEMA_MISMATCH = missingRequired;

  const accepted = await makeMetricEventFixture();
  const first = await (await sendMetricEvent(accepted, metricEventBody())).json();
  const replay = await (await sendMetricEvent(accepted, metricEventBody())).json();

  return {
    errors,
    success: { first, replay },
    probes: { missingRequired, nestedRequired, wrongType },
    diagnostic: JSON.stringify(errorsLog),
  };
}

async function conflictResponse(): Promise<Response> {
  const fixture = await makeMetricEventFixture();
  const first = await sendMetricEvent(fixture, metricEventBody());
  expect(first.status).toBe(202);
  return sendMetricEvent(fixture, metricEventBody({ fields: { converted: false } }));
}

function purchaseLimitVersion() {
  return {
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
  };
}
