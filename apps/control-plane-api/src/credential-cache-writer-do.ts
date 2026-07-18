import { DurableObject } from "cloudflare:workers";
import { CredentialCacheKVSchema, kvEnvelope } from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import type {
  CredentialCacheWrite,
  CredentialCacheWriter,
  CredentialCacheWriterAccess,
} from "./credential-cache";
import type { ControlPlaneApiEnv } from "./env";

export interface CredentialCacheWriterDurableObjectNamespace {
  getByName(name: string): CredentialCacheWriter;
}

export function durableCredentialCacheWriterAccess(
  namespace: CredentialCacheWriterDurableObjectNamespace,
): CredentialCacheWriterAccess {
  return { writerFor: (key) => namespace.getByName(key) };
}

/** A key-addressed DO makes cache writes linearizable with revoke and restriction updates. */
export class CredentialCacheWriterDurableObject
  extends DurableObject<ControlPlaneApiEnv>
  implements CredentialCacheWriter
{
  async put(write: CredentialCacheWrite): Promise<void> {
    const candidate = credentialEnvelope.parse(JSON.parse(write.value)).data;
    await assertCurrentCredential(this.env, write.credential, candidate);
    await this.env.CREDENTIAL_STORE.put(write.key, write.value, write.options);
  }
}

const credentialEnvelope = kvEnvelope(CredentialCacheKVSchema);

async function assertCurrentCredential(
  env: ControlPlaneApiEnv,
  source: CredentialCacheWrite["credential"],
  candidate: ReturnType<typeof CredentialCacheKVSchema.parse>,
): Promise<void> {
  const credentials = createRepository(env.DB).credentials;
  if (source.kind === "client_key") {
    const current = await credentials.getClientKeyForCacheBackfill(source.keyId);
    assertCommonAuthority(current, candidate);
    if (
      candidate.kind !== "client_key" ||
      !sameJson(candidate.originAllowlist ?? null, parseJson(current.originAllowlist)) ||
      candidate.rateLimitRps !== current.rateLimitRps
    ) {
      throw new Error("credential cache write rejected: Client Key restrictions are stale");
    }
    return;
  }
  const current = await credentials.getApiKeyForCacheBackfill(source.keyId);
  assertCommonAuthority(current, candidate);
  if (candidate.kind !== "api_key" || !sameJson(candidate.scopes, parseJson(current.scopes))) {
    throw new Error("credential cache write rejected: API Key scopes are stale");
  }
}

function assertCommonAuthority(
  current: {
    appId: string;
    environmentId: string;
    organizationId: string;
    revokedAt: string | null;
  } | null,
  candidate: ReturnType<typeof CredentialCacheKVSchema.parse>,
): asserts current is NonNullable<typeof current> {
  if (
    !current ||
    current.appId !== candidate.appId ||
    current.environmentId !== candidate.environmentId
  ) {
    throw new Error("credential cache write rejected: credential is no longer authoritative");
  }
  if (
    current.organizationId !== candidate.organizationId &&
    !(candidate.revoked && candidate.organizationId === null)
  ) {
    throw new Error("credential cache write rejected: Organization scope is stale");
  }
  if ((current.revokedAt !== null) !== candidate.revoked) {
    throw new Error("credential cache write rejected: revocation state is stale");
  }
}

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
