import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  routeRegistry,
  routesSurfacedBy,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeDataPlaneAuthResolver } from "./data-plane-auth";
import { EXPIRY_NOW, expiryRequest } from "./environment-expiry.test-fixture";
import { API_KEY, CLIENT_KEY, makeSdkRouteHarness, sha256Hex } from "./sdk-route-test-fixtures";

const KEY_ROUTES = routeRegistry.filter((route) =>
  ["client-key", "api-key", "data-plane-key"].includes(route.auth),
);

afterEach(() => vi.restoreAllMocks());

it("covers every registry route authenticated with a Client Key or API Key at the public edge", () => {
  expect(KEY_ROUTES.length).toBeGreaterThan(0);
  expect(routesSurfacedBy("evaluation-api")).toEqual(expect.arrayContaining(KEY_ROUTES));
});

describe.each(KEY_ROUTES)("$method $path expiry", (route) => {
  it.each([CLIENT_KEY, API_KEY])(
    "rejects %s at/after expiry and after teardown without billing or delegation",
    async (material) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(EXPIRY_NOW));
      const rateLimiter = vi.fn(() => ({ limited: false as const }));
      const downstream = vi.fn(async () => new Response(null, { status: 204 }));
      const fixture = await makeSdkRouteHarness({
        liveRun: true,
        rateLimiter,
        delegationBindings: {
          "event-ingest-api": { fetch: downstream },
          "control-plane-api": { fetch: downstream },
        },
      });
      const key = (material === CLIENT_KEY ? clientKeyCacheKey : apiKeyCacheKey)(
        await sha256Hex(material),
      );
      const cached = JSON.parse((await fixture.credentialKv.get(key)) as string);
      cached.data.credentialSchemaVersion = 3;
      for (const expiresAt of [
        EXPIRY_NOW,
        "2026-10-17T11:59:59.999Z",
        "2026-10-17T14:00:00+02:00",
      ]) {
        cached.data.expiresAt = expiresAt;
        fixture.credentialKv.putRaw(key, JSON.stringify(cached));
        const response = await fixture.app.request(...expiryRequest(route, material));
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
          code: "ENVIRONMENT_EXPIRED",
          details: {
            environmentId: cached.data.environmentId,
            expiredAt: expiresAt,
            recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT",
          },
        });
      }
      fixture.credentialKv.putRaw(
        credentialRevocationCacheKey(key),
        TERMINAL_CREDENTIAL_REVOCATION_MARKER,
      );
      // Revocation must win even when the cache payload is no longer readable.
      fixture.credentialKv.putRaw(key, "invalid JSON");
      const revoked = await fixture.app.request(...expiryRequest(route, material));
      expect(revoked.status).toBe(403);
      expect(await revoked.json()).toMatchObject({ code: "CREDENTIAL_REVOKED" });
      expect(rateLimiter).not.toHaveBeenCalled();
      expect(downstream).not.toHaveBeenCalled();
      expect(fixture.evaluationUsageSink.writes).toEqual([]);
      expect(fixture.exposureSink.writes).toEqual([]);
      expect(fixture.assignmentStore.putCalls).toEqual([]);
      expect(fixture.configKv.getCalls).toEqual([]);
    },
  );

  it("reports a malformed v3 ISO expiry as an invalid-blob fault before rate limiting", async () => {
    const onError = vi.fn();
    const rateLimiter = vi.fn(() => ({ limited: false as const }));
    const downstream = vi.fn();
    const fixture = await makeSdkRouteHarness({
      rateLimiter,
      observability: { onError },
      delegationBindings: {
        "event-ingest-api": { fetch: downstream },
        "control-plane-api": { fetch: downstream },
      },
    });
    const material = route.auth === "client-key" ? CLIENT_KEY : API_KEY;
    const key = (material === CLIENT_KEY ? clientKeyCacheKey : apiKeyCacheKey)(
      await sha256Hex(material),
    );
    const cached = JSON.parse((await fixture.credentialKv.get(key)) as string);
    cached.data = { ...cached.data, credentialSchemaVersion: 3, expiresAt: "invalid expiry" };
    fixture.credentialKv.putRaw(key, JSON.stringify(cached));
    const response = await fixture.app.request(...expiryRequest(route, material));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INTERNAL_SERVER_ERROR", cause: expect.any(Error) }),
    );
    expect(rateLimiter).not.toHaveBeenCalled();
    expect(downstream).not.toHaveBeenCalled();
    expect(fixture.evaluationUsageSink.writes).toEqual([]);
  });
});

describe.each([CLIENT_KEY, API_KEY])("v3 authentication with %s", (material) => {
  it.each([null, "2026-10-17T12:00:00.001Z"])(
    "allows expiry %s before the deadline",
    async (expiresAt) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(EXPIRY_NOW));
      const fixture = await makeSdkRouteHarness();
      const key = (material === CLIENT_KEY ? clientKeyCacheKey : apiKeyCacheKey)(
        await sha256Hex(material),
      );
      const cached = JSON.parse((await fixture.credentialKv.get(key)) as string);
      cached.data = { ...cached.data, credentialSchemaVersion: 3, expiresAt };
      fixture.credentialKv.putRaw(key, JSON.stringify(cached));
      await expect(
        makeDataPlaneAuthResolver(fixture.credentialKv)(
          new Request("https://edge.test", { headers: { authorization: `Bearer ${material}` } }),
        ),
      ).resolves.toMatchObject({ ok: true });
      cached.data.revoked = true;
      cached.data.expiresAt = EXPIRY_NOW;
      fixture.credentialKv.putRaw(key, JSON.stringify(cached));
      await expect(
        makeDataPlaneAuthResolver(fixture.credentialKv)(
          new Request("https://edge.test", { headers: { authorization: `Bearer ${material}` } }),
        ),
      ).resolves.toMatchObject({ ok: false, reason: "CREDENTIAL_REVOKED" });
    },
  );
});
