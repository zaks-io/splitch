import { DELEGATED_IDENTITY_HEADER } from "@splitch/worker-runtime";
import { describe, expect, it } from "vitest";
import type { ErrorResponse } from "@splitch/contracts";
import {
  APP_ID,
  CLIENT_KEY,
  ENVIRONMENT_ID,
  LOCKED_CLIENT_KEY,
  makeSdkRouteHarness,
  sha256Hex,
} from "./sdk-route-test-fixtures";

describe("Metric Event delegation", () => {
  it("authorizes at the public edge and forwards the caller identity to Event Ingest", async () => {
    const forwarded: Request[] = [];
    const eventIngest = {
      async fetch(input: RequestInfo | URL) {
        if (!(input instanceof Request)) throw new Error("delegation did not send a Request");
        forwarded.push(input);
        return Response.json({ accepted: true }, { status: 202 });
      },
    };
    const { app } = await makeSdkRouteHarness({ eventIngest });

    const response = await app.request("/api/sdk/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(metricEvent()),
    });

    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    const request = forwarded[0];
    expect(await request?.json()).toEqual(metricEvent());
    expect(request?.headers.get("authorization")).toBeNull();
    expect(JSON.parse(request?.headers.get(DELEGATED_IDENTITY_HEADER) ?? "{}")).toEqual({
      operation: "sdk_track",
      actorId: `client_key:${await sha256Hex(CLIENT_KEY)}`,
      orgId: "org_verify",
      appId: APP_ID,
      environmentId: ENVIRONMENT_ID,
    });
  });

  // The Client Key origin allow-list is enforced here, at the public edge, and
  // nowhere downstream: the browser Origin header does not cross the service
  // binding, so Event Ingest has nothing left to check.
  it("rejects a disallowed origin before anything reaches Event Ingest", async () => {
    const forwarded: Request[] = [];
    const eventIngest = {
      async fetch(input: RequestInfo | URL) {
        forwarded.push(input as Request);
        return Response.json({ accepted: true }, { status: 202 });
      },
    };
    const { app } = await makeSdkRouteHarness({ eventIngest });

    const response = await app.request("/api/sdk/events", {
      method: "POST",
      headers: {
        authorization: `Bearer ${LOCKED_CLIENT_KEY}`,
        "content-type": "application/json",
        origin: "https://denied.example",
      },
      body: JSON.stringify(metricEvent()),
    });

    expect(((await response.json()) as ErrorResponse).code).toBe("ORIGIN_NOT_ALLOWED");
    expect(forwarded).toHaveLength(0);
  });
});

function metricEvent() {
  return {
    eventName: "signed_up",
    targetingKey: "entity-7",
    idType: "user",
    eventId: "123e4567-e89b-42d3-a456-426614174000",
    fields: { converted: true },
    dimensions: { plan: "pro" },
  };
}
