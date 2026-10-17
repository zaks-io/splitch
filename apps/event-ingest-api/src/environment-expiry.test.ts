import {
  apiKeyCacheKey,
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  routeRegistry,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateDelegatedDataPlaneCredential } from "./client-key-auth";
import {
  credentialKey,
  credentialRecord,
  delegatedIdentity,
  envWithValues,
} from "./client-key-auth.test-fixture";
import { EvaluationEntrypoint } from "./index";
import { makeMetricEventFixture, metricEventBody } from "./metric-event.test-fixture";
import { TestExecutionContext } from "./test-execution-context";

const NOW = "2026-10-17T12:00:00.000Z";
afterEach(() => vi.restoreAllMocks());

const routes = routeRegistry.filter(
  (route) =>
    route.owner === "event-ingest-api" &&
    ["client-key", "api-key", "data-plane-key"].includes(route.auth),
);

describe.each(["client_key", "api_key"] as const)("%s expiry at Event Ingest", (kind) => {
  it.each(routes)(
    "rejects at/after expiry before admission, claims, or writes on $operationId",
    async (route) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(NOW));
      const fixture = await makeMetricEventFixture({}, kind);
      const key = (kind === "client_key" ? clientKeyCacheKey : apiKeyCacheKey)(fixture.hash);
      const cached = JSON.parse((await fixture.env.CREDENTIAL_STORE?.get(key, "text")) as string);
      cached.data.credentialSchemaVersion = 3;
      const values = new Map<string, string>();
      const get = vi.fn(async (readKey: string) => values.get(readKey) ?? null);
      fixture.env.CREDENTIAL_STORE = { get } as unknown as KVNamespace;
      const limiter = { idFromName: vi.fn() };
      fixture.env.METRIC_EVENT_RATE_LIMIT = limiter as unknown as NonNullable<
        typeof fixture.env.METRIC_EVENT_RATE_LIMIT
      >;
      const configStore = fixture.env.CONFIG_STORE;
      if (!configStore) throw new Error("Expiry fixture requires CONFIG_STORE");
      const configGet = vi.spyOn(configStore, "get");

      const send = () =>
        new EvaluationEntrypoint(new TestExecutionContext(), fixture.env).fetch(
          delegatedRequest(
            route,
            {
              operation: route.operationId,
              actorId: `${kind}:${fixture.hash}`,
              orgId: "org_1",
              appId: "app_shop",
              environmentId: "env_prod",
            },
            { body: metricEventBody() },
          ),
        );
      for (const expiresAt of [NOW, "2026-10-17T11:59:59.999Z"]) {
        cached.data.expiresAt = expiresAt;
        values.set(key, JSON.stringify(cached));
        const response = await send();
        expect(response.status).toBe(410);
        expect(await response.json()).toMatchObject({
          code: "ENVIRONMENT_EXPIRED",
          details: { expiredAt: expiresAt, recommendedAction: "CREATE_TEMPORARY_ENVIRONMENT" },
        });
      }
      expect(limiter.idFromName).not.toHaveBeenCalled();
      expect(fixture.admissionCharges).toEqual([]);
      expect(fixture.claims.size).toBe(0);
      expect(fixture.writerRequests).toEqual([]);
      expect(configGet).not.toHaveBeenCalled();

      const faults = vi.spyOn(console, "error").mockImplementation(() => undefined);
      cached.data.expiresAt = "invalid expiry";
      values.set(key, JSON.stringify(cached));
      const invalid = await send();
      expect(invalid.status).toBe(500);
      expect(await invalid.json()).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
      expect(JSON.stringify(faults.mock.calls)).toContain("request_fault");
      expect(fixture.admissionCharges).toEqual([]);
      expect(limiter.idFromName).not.toHaveBeenCalled();

      values.set(credentialRevocationCacheKey(key), TERMINAL_CREDENTIAL_REVOCATION_MARKER);
      values.set(key, "invalid JSON");
      const response = await send();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "CREDENTIAL_REVOKED" });
      expect(fixture.admissionCharges).toEqual([]);
      expect(fixture.claims.size).toBe(0);
    },
  );

  it.each([null, "2026-10-17T12:00:00.001Z"])(
    "allows v3 expiry %s before its deadline",
    async (expiresAt) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse(NOW));
      const record = JSON.parse(credentialRecord(kind));
      record.data.credentialSchemaVersion = 3;
      record.data.expiresAt = expiresAt;
      const env = envWithValues(new Map([[credentialKey(kind), JSON.stringify(record)]]));
      expect(
        await authenticateDelegatedDataPlaneCredential(delegatedIdentity(kind), env),
      ).toMatchObject({ ok: true });
    },
  );
});
