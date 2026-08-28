import {
  credentialRevocationCacheKey,
  TERMINAL_CREDENTIAL_REVOCATION_MARKER,
} from "@splitch/contracts";
import { describe, expect, it } from "vitest";
import { authenticateDelegatedDataPlaneCredential } from "./client-key-auth";
import {
  credentialFixtures,
  credentialKey,
  credentialRecord,
  type CredentialKind,
  delegatedIdentity,
  envWithCredential,
  envWithValues,
} from "./client-key-auth.test-fixture";

describe("delegated Metric Event credential compatibility", () => {
  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("accepts an active %s with data-plane:write from its own cache", async (kind) => {
    const readKeys: string[] = [];
    const result = await authenticateDelegatedDataPlaneCredential(
      delegatedIdentity(kind),
      envWithCredential(kind, {}, readKeys),
    );

    expect(result).toEqual({
      ok: true,
      value: {
        credentialHash: credentialFixtures[kind].hash,
        credentialKind: kind,
        appId: credentialFixtures[kind].appId,
        environmentId: credentialFixtures[kind].environmentId,
        rateLimitRps: kind === "client_key" ? 12 : null,
      },
    });
    expect(readKeys).toEqual([
      credentialRevocationCacheKey(credentialKey(kind)),
      credentialKey(kind),
    ]);
  });

  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("refuses a revoked %s", async (kind) => {
    const result = await authenticateDelegatedDataPlaneCredential(
      delegatedIdentity(kind),
      envWithCredential(kind, { revoked: true }),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "CREDENTIAL_REVOKED" } });
  });

  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("gives a terminal revocation marker precedence for %s", async (kind) => {
    const key = credentialKey(kind);
    const result = await authenticateDelegatedDataPlaneCredential(
      delegatedIdentity(kind),
      envWithValues(
        new Map([
          [key, credentialRecord(kind)],
          [credentialRevocationCacheKey(key), TERMINAL_CREDENTIAL_REVOCATION_MARKER],
        ]),
      ),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "CREDENTIAL_REVOKED" } });
  });

  it.each([
    "client_key",
    "api_key",
  ] satisfies CredentialKind[])("accepts a schema-v1 %s record", async (kind) => {
    const result = await authenticateDelegatedDataPlaneCredential(
      delegatedIdentity(kind),
      envWithCredential(kind, {}, [], 1),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        credentialHash: credentialFixtures[kind].hash,
        appId: credentialFixtures[kind].appId,
        environmentId: credentialFixtures[kind].environmentId,
      },
    });
  });
});
