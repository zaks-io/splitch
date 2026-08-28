import { describe, expect, it } from "vitest";
import { MetricEventTrackResponseSchema } from "./metric-event";
import { routeRegistry } from "./route-registry";
import { DataPlaneEvaluateResponseSchema } from "./wire-envelopes-core";

const PUBLIC_SUCCESS_BY_OPERATION: Record<string, unknown> = {
  sdk_track: {
    accepted: true,
    duplicate: false,
    eventId: "123e4567-e89b-42d3-a456-426614174000",
  },
  sdk_evaluate: { variant: true },
  sdk_cached_evaluation_telemetry: { ok: true },
  sdk_verify: {
    value: true,
    variantName: "treatment",
    reason: "SPLIT",
  },
  sdk_evaluate_all: {
    evaluations: {
      "checkout-banner": {
        variant: true,
        variantName: "treatment",
        reason: "SPLIT",
        errorCode: null,
        exposureIdentity: null,
        exposureTicket: null,
      },
    },
  },
  sdk_exposures: {
    results: [
      {
        exposureId: "123e4567-e89b-42d3-a456-426614174000",
        status: "accepted",
        code: null,
      },
    ],
  },
};

describe("public Client Key success shapes", () => {
  it("accepts Client Key track success without Event Definition IDs and keeps them optional", () => {
    const publicSuccess = MetricEventTrackResponseSchema.parse({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(publicSuccess).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "123e4567-e89b-42d3-a456-426614174000",
    });
    expect(publicSuccess.eventDefinitionId).toBeUndefined();
    expect(publicSuccess.eventDefinitionVersionId).toBeUndefined();
    expect(
      MetricEventTrackResponseSchema.parse({
        accepted: true,
        duplicate: true,
        eventId: "123e4567-e89b-42d3-a456-426614174000",
        eventDefinitionId: "ed_signed_up",
        eventDefinitionVersionId: "edv_1",
      }).eventDefinitionId,
    ).toBe("ed_signed_up");
  });

  it("derives every Evaluation/Event Ingest Client Key success schema from the registry", () => {
    const routes = routeRegistry.filter(
      (route) =>
        (route.owner === "evaluation-api" || route.owner === "event-ingest-api") &&
        (route.auth === "client-key" || route.auth === "data-plane-key"),
    );
    expect(routes.map((route) => route.operationId).sort()).toEqual(
      Object.keys(PUBLIC_SUCCESS_BY_OPERATION).sort(),
    );
    expect(DataPlaneEvaluateResponseSchema.parse({ variant: true })).toEqual({ variant: true });
    for (const route of routes) {
      const example = PUBLIC_SUCCESS_BY_OPERATION[route.operationId];
      if (example === undefined) {
        throw new Error(`public success example missing for ${route.operationId}`);
      }
      const parsed = route.output.parse(example);
      expect(JSON.stringify(parsed)).not.toContain("eventDefinitionId");
      expect(JSON.stringify(parsed)).not.toContain("eventDefinitionVersionId");
      expect(JSON.stringify(parsed)).not.toContain("ruleId");
    }
  });
});
