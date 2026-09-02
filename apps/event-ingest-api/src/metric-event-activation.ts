import {
  type ActivationBindingKV,
  ActivationConfigKVSchema,
  activationConfigKey,
  kvEnvelope,
  type MetricEventTrackRequest,
} from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import type { Env } from "./types";

const ActivationConfigEnvelope = kvEnvelope(ActivationConfigKVSchema);

export async function activationRows(
  env: Env,
  credential: MetricEventCredentialScope,
  event: MetricEventTrackRequest,
  identity: { targetingKeyHash: string; entityFamilyHash: string },
  eventDefinitionId: string,
  serverReceivedAt: string,
): Promise<Record<string, unknown>[]> {
  if (!env.CONFIG_STORE) throw new Error("CONFIG_STORE binding is unavailable");
  const raw = await env.CONFIG_STORE.get(
    activationConfigKey(credential.appId, credential.environmentId),
    "text",
  );
  if (raw === null) return [];
  const config = ActivationConfigEnvelope.parse(JSON.parse(raw)).data;
  const bindings = config.bindings.filter(
    (binding) => binding.eventDefinitionId === eventDefinitionId,
  );
  if (bindings.length === 0) {
    throw new Error("No live Experiment Run uses this Event Definition for Activation");
  }
  for (const binding of bindings) {
    if (binding.idType !== event.idType) {
      throw new Error("Activation binding Entity type does not match its Event Definition");
    }
  }
  const sourceId =
    env.SPLITCH_SOURCE_ID ?? (env.SPLITCH_PLATFORM_TARGET === "local" ? "local" : null);
  if (!sourceId) throw new Error("Activation source identity is unavailable");
  return Promise.all(
    bindings.map((binding) =>
      activationRow(credential, event, identity, binding, sourceId, serverReceivedAt),
    ),
  );
}

async function activationRow(
  credential: MetricEventCredentialScope,
  event: MetricEventTrackRequest,
  identity: { targetingKeyHash: string; entityFamilyHash: string },
  binding: ActivationBindingKV,
  sourceId: string,
  serverReceivedAt: string,
): Promise<Record<string, unknown>> {
  return {
    dedup_key: await activationDedupKey(credential.appId, binding, event.eventId, sourceId),
    app_id: credential.appId,
    environment_id: credential.environmentId,
    experiment_id: binding.experimentId,
    run_id: binding.runId,
    id_type: binding.idType,
    targeting_key_hash: identity.targetingKeyHash,
    entity_family_hash: identity.entityFamilyHash,
    variant: null,
    type: "activation",
    event_id: event.eventId,
    counterfactual: 0,
    source_id: sourceId,
    client_timestamp: null,
    exposure_at: serverReceivedAt,
    server_received_at: serverReceivedAt,
    activation_ts: serverReceivedAt,
    is_holdover: 0,
    sdk_version: null,
  };
}

async function activationDedupKey(
  appId: string,
  binding: ActivationBindingKV,
  eventId: string,
  sourceId: string,
): Promise<string> {
  const material = [
    "activation",
    appId,
    binding.experimentId,
    binding.runId,
    binding.idType,
    sourceId,
    eventId,
  ].join(":");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
