import type { ApiRouteContract } from "@splitch/contracts";
import { requestArgs } from "./convex-exposures-test-fixture";

export const EXPIRY_NOW = "2026-10-17T12:00:00.000Z";
const UUID = "00000000-0000-4000-8000-000000000001";

export function expiryRequest(route: ApiRouteContract, material: string): [string, RequestInit] {
  const path = route.path.replace(/:[^/]+/g, (param) =>
    param === ":installationId" ? UUID : "checkout",
  );
  return [
    path,
    {
      method: route.method,
      headers: {
        authorization: `Bearer ${material}`,
        "content-type": "application/json",
        "idempotency-key": "expiry-test",
      },
      ...(route.method === "GET" || route.method === "DELETE"
        ? {}
        : {
            body: JSON.stringify(bodyFor(route.operationId)),
          }),
    },
  ];
}

function bodyFor(operation: string): unknown {
  switch (operation) {
    case "ofrep_evaluate":
    case "ofrep_evaluate_bulk":
      return {};
    case "sdk_exposures":
      return {
        exposures: [{ exposureId: UUID, exposureTicket: "ticket", clientTimestamp: EXPIRY_NOW }],
      };
    case "sdk_cached_evaluation_telemetry":
      return { flagKey: "checkout", idempotencyKey: "expiry-test" };
    case "sdk_track":
    case "sdk_activate":
      return {
        eventName: "signed_up",
        targetingKey: "user-1",
        idType: "user",
        eventId: UUID,
        fields: {},
        dimensions: {},
      };
    case "cloudflare_installations_create":
      return {
        installationId: UUID,
        endpoint: "https://example.test/events",
        pushSecret: "test-only-secret".repeat(4),
      };
    case "convex_installations_create":
      return {
        installationId: UUID,
        callbackUrl: "https://example.test/events",
        webhookSecret: "test-only-secret".repeat(4),
      };
    case "convex_secret_rotations_create":
      return { rotationId: UUID, webhookSecret: "test-only-secret".repeat(4) };
    case "cloudflare_exposures_create":
    case "convex_exposures_create":
      return (requestArgs().input as { body: unknown }).body;
    default:
      return {
        ...(operation === "sdk_evaluate_all" ? {} : { flagKey: "checkout" }),
        targetingKey: "user-1",
        idType: "user",
        attributes: {},
      };
  }
}
