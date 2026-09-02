import {
  type ActivationBindingKV,
  ActivationConfigKVSchema,
  type AssignmentStoreEntry,
  AssignmentStoreValueSchema,
  activationConfigKey,
  assignmentKey,
  kvEnvelope,
  type MetricEventTrackRequest,
} from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import type { Env } from "./types";

const ActivationConfigEnvelope = kvEnvelope(ActivationConfigKVSchema);
const AssignmentEnvelope = kvEnvelope(AssignmentStoreValueSchema);

export async function activationRows(
  env: Env,
  credential: MetricEventCredentialScope,
  event: MetricEventTrackRequest,
  identity: {
    targetingKeyHash: string;
    targetingKeyHashes: readonly string[];
    entityFamilyHash: string;
  },
  eventDefinitionId: string,
): Promise<Record<string, unknown>[]> {
  if (!env.CONFIG_STORE) throw new Error("CONFIG_STORE binding is unavailable");
  const raw = await env.CONFIG_STORE.get(
    activationConfigKey(credential.appId, credential.environmentId),
    "text",
  );
  if (raw === null) throw new Error("Activation configuration is unavailable");
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
  const assignments = await loadAssignments(env, credential.appId, event.idType, identity);
  const exposedBindings = bindings.flatMap((binding) => {
    const located = assignments[binding.experimentId];
    return located?.assignment.runId === binding.runId ? [{ binding, ...located }] : [];
  });
  if (exposedBindings.length === 0) {
    throw new Error("Exposure proof is unavailable for matching live Experiment Runs");
  }
  const sourceId =
    env.SPLITCH_SOURCE_ID ?? (env.SPLITCH_PLATFORM_TARGET === "local" ? "local" : null);
  if (!sourceId) throw new Error("Activation source identity is unavailable");
  const serverReceivedAt = new Date().toISOString();
  return Promise.all(
    exposedBindings.map(({ assignment, binding, targetingKeyHash }) =>
      activationRow(
        credential,
        event,
        { entityFamilyHash: identity.entityFamilyHash, targetingKeyHash },
        binding,
        assignment.variant,
        sourceId,
        serverReceivedAt,
      ),
    ),
  );
}

async function loadAssignments(
  env: Env,
  appId: string,
  idType: string,
  identity: { targetingKeyHashes: readonly string[] },
): Promise<Record<string, LocatedAssignment>> {
  const assignmentsKv = env.ASSIGNMENTS_KV;
  if (!assignmentsKv) throw new Error("ASSIGNMENTS_KV binding is unavailable");
  const values = await Promise.all(
    identity.targetingKeyHashes.map(async (targetingKeyHash) => {
      const raw = await assignmentsKv.get(assignmentKey(appId, idType, targetingKeyHash), "text");
      return {
        targetingKeyHash,
        assignments: raw === null ? {} : AssignmentEnvelope.parse(JSON.parse(raw)).data,
      };
    }),
  );
  const merged: Record<string, LocatedAssignment> = {};
  for (const value of values) {
    for (const [experimentId, assignment] of Object.entries(value.assignments)) {
      const existing = merged[experimentId];
      if (
        existing !== undefined &&
        (existing.assignment.runId !== assignment.runId ||
          existing.assignment.variant !== assignment.variant)
      ) {
        throw new Error("Conflicting Assignment values across retained Entity identities");
      }
      merged[experimentId] = { assignment, targetingKeyHash: value.targetingKeyHash };
    }
  }
  return merged;
}

interface LocatedAssignment {
  readonly assignment: AssignmentStoreEntry;
  readonly targetingKeyHash: string;
}

async function activationRow(
  credential: MetricEventCredentialScope,
  event: MetricEventTrackRequest,
  identity: { targetingKeyHash: string; entityFamilyHash: string },
  binding: ActivationBindingKV,
  variant: string,
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
    variant,
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
