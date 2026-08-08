import { apiKeyCacheKey, CURRENT_KV_SCHEMA_VERSION, clientKeyCacheKey } from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { authenticateDelegatedDataPlaneCredential } from "./client-key-auth";
import type { Env } from "./types";

const hash = "a".repeat(64);
const appId = "app_authorized";
const environmentId = "env_authorized";

type CredentialKind = "api_key" | "client_key";

describe("delegated Metric Event credential", () => {
  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("accepts an active %s with data-plane:write from its own cache", async (kind) => {
    const readKeys: string[] = [];
    const result = await authenticateDelegatedDataPlaneCredential(
      identity(kind),
      envWithCredential(kind, {}, readKeys),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        credentialHash: hash,
        appId,
        environmentId,
        rateLimitRps: kind === "client_key" ? 12 : null,
      },
    });
    expect(readKeys).toEqual([credentialKey(kind)]);
  });

  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("refuses a revoked %s", async (kind) => {
    const result = await authenticateDelegatedDataPlaneCredential(
      identity(kind),
      envWithCredential(kind, { revoked: true }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "CREDENTIAL_REVOKED" } });
  });

  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("refuses a %s without data-plane:write", async (kind) => {
    const result = await authenticateDelegatedDataPlaneCredential(
      identity(kind),
      envWithCredential(kind, { scopes: ["data-plane:evaluate"] }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INSUFFICIENT_SCOPES",
        details: { requiredScopes: ["data-plane:write"] },
      },
    });
  });

  it.each([
    ["client_key", "App", { appId: "app_attacker" }],
    ["client_key", "Environment", { environmentId: "env_attacker" }],
    ["api_key", "App", { appId: "app_attacker" }],
    ["api_key", "Environment", { environmentId: "env_attacker" }],
  ] satisfies Array<
    [CredentialKind, string, Partial<ReturnType<typeof identity>>]
  >)("refuses a %s delegated with a different %s", async (kind, _scope, patch) => {
    const result = await authenticateDelegatedDataPlaneCredential(
      { ...identity(kind), ...patch },
      envWithCredential(kind),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_SERVER_ERROR" } });
  });

  it("returns App and Environment from the credential rather than rereading caller identity", async () => {
    const identityReads = { app: 0, environment: 0 };
    const delegated = {
      actorId: `client_key:${hash}`,
      get appId() {
        identityReads.app += 1;
        return identityReads.app === 1 ? appId : "app_attacker";
      },
      get environmentId() {
        identityReads.environment += 1;
        return identityReads.environment === 1 ? environmentId : "env_attacker";
      },
    };

    const result = await authenticateDelegatedDataPlaneCredential(
      delegated,
      envWithCredential("client_key"),
    );

    expect(result).toMatchObject({ ok: true, value: { appId, environmentId } });
    expect(identityReads).toEqual({ app: 1, environment: 1 });
  });
});

function identity(kind: CredentialKind) {
  return { actorId: `${kind}:${hash}`, appId, environmentId };
}

function credentialKey(kind: CredentialKind): string {
  return kind === "client_key" ? clientKeyCacheKey(hash) : apiKeyCacheKey(hash);
}

function envWithCredential(
  kind: CredentialKind,
  patch: Partial<{
    revoked: boolean;
    scopes: string[];
  }> = {},
  readKeys: string[] = [],
): Env {
  const record = JSON.stringify({
    schemaVersion: CURRENT_KV_SCHEMA_VERSION,
    data: {
      credentialSchemaVersion: 2,
      organizationId: "org_authorized",
      kind,
      appId,
      environmentId,
      scopes: ["data-plane:evaluate", "data-plane:write"],
      originAllowlist: kind === "client_key" ? null : undefined,
      rateLimitRps: kind === "client_key" ? 12 : undefined,
      revoked: false,
      cachedAt: "2026-08-08T00:00:00.000Z",
      ...patch,
    },
  });
  return {
    CREDENTIAL_STORE: {
      async get(key: string) {
        readKeys.push(key);
        return key === credentialKey(kind) ? record : null;
      },
    } as KVNamespace,
  };
}
