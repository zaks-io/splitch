import { clientKeyCacheKey } from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateDelegatedDataPlaneCredential } from "./client-key-auth";
import {
  type CredentialKind,
  credentialLabel,
  credentialRecord,
  envWithCredential,
  envWithValues,
  credentialFixtures as fixtures,
  delegatedIdentity as identity,
} from "./client-key-auth.test-fixture";
import { renderError } from "./errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("delegated Metric Event credential authorization", () => {
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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await authenticateDelegatedDataPlaneCredential(
      { ...identity(kind), ...patch },
      envWithCredential(kind),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_SERVER_ERROR" } });
  });

  it("logs complete scope mismatch evidence without returning it to the caller", async () => {
    const kind = "client_key";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const authorized = {
      ...identity(kind),
      appId: "app_delegated_attacker",
      environmentId: "env_delegated_attacker",
    };
    const result = await authenticateDelegatedDataPlaneCredential(
      authorized,
      envWithCredential(kind),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("scope mismatch was accepted");
    const detail = {
      credentialKind: kind,
      credentialHash: fixtures[kind].hash,
      credentialAppId: fixtures[kind].appId,
      credentialEnvironmentId: fixtures[kind].environmentId,
      authorizedAppId: authorized.appId,
      authorizedEnvironmentId: authorized.environmentId,
    };
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "event-ingest-api delegated credential scope mismatch",
      detail,
    );

    const body = await renderError(result.error).text();
    for (const value of Object.values(detail)) expect(body).not.toContain(value);
  });
});

describe("delegated Metric Event credential identity", () => {
  it.each([
    ["client_key", "api_key"],
    ["api_key", "client_key"],
  ] satisfies Array<
    [CredentialKind, CredentialKind]
  >)("refuses delegated %s material backed by a %s record", async (delegatedKind, storedKind) => {
    const result = await authenticateDelegatedDataPlaneCredential(
      identity(delegatedKind),
      envWithCredential(delegatedKind, { kind: storedKind }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "UNAUTHORIZED",
        message: `${credentialLabel(delegatedKind)} is unknown`,
        details: {},
      },
    });
  });

  it("rejects malformed delegated hash material before reading credential storage", async () => {
    const malformedHash = "c".repeat(63);
    const readKeys: string[] = [];
    const result = await authenticateDelegatedDataPlaneCredential(
      {
        actorId: `client_key:${malformedHash}`,
        appId: "app_malformed_actor",
        environmentId: "env_malformed_actor",
      },
      envWithValues(
        new Map([
          [
            clientKeyCacheKey(malformedHash),
            credentialRecord("client_key", {
              appId: "app_malformed_actor",
              environmentId: "env_malformed_actor",
            }),
          ],
        ]),
        readKeys,
      ),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    expect(readKeys).toEqual([]);
  });
});

describe("delegated Metric Event credential scope source", () => {
  it("returns App and Environment from the credential rather than rereading caller identity", async () => {
    const identityReads = { app: 0, environment: 0 };
    const delegated = {
      actorId: `client_key:${fixtures.client_key.hash}`,
      get appId() {
        identityReads.app += 1;
        return identityReads.app === 1 ? fixtures.client_key.appId : "app_attacker";
      },
      get environmentId() {
        identityReads.environment += 1;
        return identityReads.environment === 1 ? fixtures.client_key.environmentId : "env_attacker";
      },
    };

    const result = await authenticateDelegatedDataPlaneCredential(
      delegated,
      envWithCredential("client_key"),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        appId: fixtures.client_key.appId,
        environmentId: fixtures.client_key.environmentId,
      },
    });
    expect(identityReads).toEqual({ app: 1, environment: 1 });
  });
});
