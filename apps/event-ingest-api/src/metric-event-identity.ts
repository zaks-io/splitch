import type { MetricEventTrackRequest } from "@splitch/contracts";
import { canonicalizeAnalysisEntityHash, resolveEntityPrivacyIdentity } from "@splitch/privacy";
import type { MetricEventCredentialScope } from "./client-key-auth";
import { canonicalJson } from "./metric-event-admission";
import { makeMetricEventSaltStore } from "./metric-event-salt-store";
import type { Env } from "./types";

export async function resolveMetricEventIdentityMaterial(
  env: Env,
  credential: MetricEventCredentialScope,
  event: MetricEventTrackRequest,
) {
  const identity = await resolveEntityPrivacyIdentity(makeMetricEventSaltStore(env), {
    appId: credential.appId,
    idType: event.idType,
    targetingKey: event.targetingKey,
  });
  const targetingKeyHash = canonicalizeAnalysisEntityHash(identity.targetingKeyHashes);
  const fingerprintInput = {
    eventName: event.eventName,
    idType: event.idType,
    targetingKeyHash,
    fields: event.fields,
    dimensions: event.dimensions,
  };
  const [fingerprint, retainedFingerprints, dedupKey] = await Promise.all([
    metricEventPayloadFingerprint(fingerprintInput),
    retainedMetricEventFingerprints(identity.targetingKeyHashes, fingerprintInput),
    metricEventDedupKey(credential.appId, credential.environmentId, event.eventId),
  ]);
  return { identity, targetingKeyHash, fingerprint, retainedFingerprints, dedupKey };
}

export async function metricEventDedupKey(
  appId: string,
  environmentId: string,
  eventId: string,
): Promise<string> {
  return sha256(`metric:${appId}:${environmentId}:${eventId}`);
}

export async function metricEventPayloadFingerprint(input: {
  eventName: string;
  idType: string;
  targetingKeyHash: string;
  fields: unknown;
  dimensions: unknown;
}): Promise<string> {
  return sha256(canonicalJson(input));
}

async function retainedMetricEventFingerprints(
  hashes: readonly string[],
  input: Parameters<typeof metricEventPayloadFingerprint>[0],
): Promise<readonly string[]> {
  return Promise.all(
    hashes
      .filter((hash) => hash !== input.targetingKeyHash)
      .map((targetingKeyHash) => metricEventPayloadFingerprint({ ...input, targetingKeyHash })),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
