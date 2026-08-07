import {
  clientKeyCacheKey,
  credentialRevocationCacheKey,
  CredentialCacheKVSchemaV1,
  kvEnvelope,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { makeDataPlaneAuthResolver, sha256Hex } from "./data-plane-auth";

const CLIENT_KEY = "pk_legacy_client";
const legacyEnvelope = kvEnvelope(CredentialCacheKVSchemaV1);

class CredentialStore {
  constructor(private readonly values: Map<string, string>) {}

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
}

describe("data-plane credential cache compatibility", () => {
  it("gives terminal revocation precedence over a stale active Client Key entry", async () => {
    const hash = await sha256Hex(CLIENT_KEY);
    const cacheKey = clientKeyCacheKey(hash);
    const active = JSON.stringify({
      schemaVersion: 2,
      data: {
        appId: "app_revoked",
        environmentId: "env_revoked",
        credentialSchemaVersion: 2,
        organizationId: "org_revoked",
        kind: "client_key",
        scopes: ["data-plane:evaluate"],
        originAllowlist: null,
        rateLimitRps: null,
        revoked: false,
        cachedAt: "2026-08-07T00:00:00.000Z",
      },
    });
    const store = new CredentialStore(
      new Map([
        [cacheKey, active],
        [credentialRevocationCacheKey(cacheKey), "revoked"],
      ]),
    );

    await expect(
      makeDataPlaneAuthResolver(store)(
        new Request("https://edge.test/api/sdk/evaluate", {
          headers: { authorization: `Bearer ${CLIENT_KEY}` },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "CREDENTIAL_REVOKED" });
  });

  it("reads schema-v1 credentials with an explicit unscoped migration marker", async () => {
    const key = await sha256Hex(CLIENT_KEY);
    const store = new CredentialStore(
      new Map([
        [
          `ck:${key}`,
          JSON.stringify(
            legacyEnvelope.parse({
              schemaVersion: 1,
              data: {
                appId: "app_legacy",
                environmentId: "env_legacy",
                kind: "client_key",
                scopes: ["data-plane:evaluate"],
                originAllowlist: null,
                rateLimitRps: null,
                revoked: false,
                cachedAt: "2026-07-02T00:00:00.000Z",
              },
            }),
          ),
        ],
      ]),
    );

    const result = await makeDataPlaneAuthResolver(store)(
      new Request("https://edge.test/api/sdk/evaluate", {
        headers: { authorization: `Bearer ${CLIENT_KEY}` },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      principal: {
        kind: "client-key",
        appId: "app_legacy",
        environmentId: "env_legacy",
        orgId: null,
      },
    });
  });

  it("never accepts an organization claim from the request as credential scope", async () => {
    const key = await sha256Hex(CLIENT_KEY);
    const store = new CredentialStore(
      new Map([
        [
          `ck:${key}`,
          JSON.stringify({
            schemaVersion: 1,
            data: {
              appId: "app_legacy",
              environmentId: "env_legacy",
              kind: "client_key",
              scopes: ["data-plane:evaluate"],
              originAllowlist: null,
              rateLimitRps: null,
              revoked: false,
              cachedAt: "2026-07-02T00:00:00.000Z",
            },
          }),
        ],
      ]),
    );

    const result = await makeDataPlaneAuthResolver(store)(
      new Request("https://edge.test/api/sdk/evaluate", {
        headers: {
          authorization: `Bearer ${CLIENT_KEY}`,
          "x-splitch-organization-id": "org_attacker",
        },
      }),
    );

    expect(result).toMatchObject({ ok: true, principal: { orgId: null } });
  });
});
