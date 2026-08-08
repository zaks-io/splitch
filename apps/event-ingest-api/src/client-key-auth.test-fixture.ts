import { apiKeyCacheKey, CURRENT_KV_SCHEMA_VERSION, clientKeyCacheKey } from "@splitch/contracts";
import type { Env } from "./types";

export type CredentialKind = "api_key" | "client_key";

export const credentialFixtures = {
  client_key: {
    hash: "a".repeat(64),
    appId: "app_client_authorized",
    environmentId: "env_client_authorized",
  },
  api_key: {
    hash: "b".repeat(64),
    appId: "app_api_authorized",
    environmentId: "env_api_authorized",
  },
} as const;

interface DelegatedIdentity {
  actorId: string;
  appId: string;
  environmentId: string;
}

export function delegatedIdentity(kind: CredentialKind): DelegatedIdentity {
  const fixture = credentialFixtures[kind];
  return {
    actorId: `${kind}:${fixture.hash}`,
    appId: fixture.appId,
    environmentId: fixture.environmentId,
  };
}

export function credentialKey(kind: CredentialKind): string {
  const hash = credentialFixtures[kind].hash;
  return kind === "client_key" ? clientKeyCacheKey(hash) : apiKeyCacheKey(hash);
}

export function envWithCredential(
  kind: CredentialKind,
  patch: CredentialPatch = {},
  readKeys: string[] = [],
  schemaVersion: 1 | 2 = 2,
): Env {
  return envWithValues(
    new Map([[credentialKey(kind), credentialRecord(kind, patch, schemaVersion)]]),
    readKeys,
  );
}

interface CredentialPatch {
  kind?: CredentialKind;
  appId?: string;
  environmentId?: string;
  revoked?: boolean;
  scopes?: string[];
}

export function credentialRecord(
  kind: CredentialKind,
  patch: CredentialPatch = {},
  schemaVersion: 1 | 2 = 2,
): string {
  const fixture = credentialFixtures[kind];
  const versioned =
    schemaVersion === 2
      ? { credentialSchemaVersion: 2 as const, organizationId: `org_${kind}_authorized` }
      : {};
  return JSON.stringify({
    schemaVersion: schemaVersion === 2 ? CURRENT_KV_SCHEMA_VERSION : 1,
    data: {
      ...versioned,
      kind,
      appId: fixture.appId,
      environmentId: fixture.environmentId,
      scopes: ["data-plane:evaluate", "data-plane:write"],
      originAllowlist: kind === "client_key" ? null : undefined,
      rateLimitRps: kind === "client_key" ? 12 : undefined,
      revoked: false,
      cachedAt: "2026-08-08T00:00:00.000Z",
      ...patch,
    },
  });
}

export function envWithValues(values: Map<string, string>, readKeys: string[] = []): Env {
  return {
    CREDENTIAL_STORE: {
      async get(key: string) {
        readKeys.push(key);
        return values.get(key) ?? null;
      },
    } as KVNamespace,
  };
}

export function credentialLabel(kind: CredentialKind): "API Key" | "Client Key" {
  return kind === "client_key" ? "Client Key" : "API Key";
}
