import {
  type ActivationBindingKV,
  ActivationConfigKVSchema,
  type AssignmentStoreEntry,
  AssignmentStoreValueSchema,
  activationConfigKey,
  assignmentKey,
  kvEnvelope,
  LiveRunKVSchema,
  liveRunKey,
  type MetricEventTrackRequest,
} from "@splitch/contracts";
import type { MetricEventCredentialScope } from "./client-key-auth";
import type { Env } from "./types";

const ActivationConfigEnvelope = kvEnvelope(ActivationConfigKVSchema);
const AssignmentEnvelope = kvEnvelope(AssignmentStoreValueSchema);
const LiveRunEnvelope = kvEnvelope(LiveRunKVSchema);

/**
 * A named resolution failure, so the ingest handler can report WHICH step failed
 * instead of collapsing every cause into one opaque "configuration is
 * unavailable". `detail` is operator-only: it names ids the public Client Key
 * response must not carry, and goes to the log, never to the body.
 */
export class ActivationResolutionError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "ActivationResolutionError";
    this.detail = detail;
  }
}

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
  if (!env.CONFIG_STORE) {
    throw new ActivationResolutionError("Activation configuration store is unavailable");
  }
  const raw = await env.CONFIG_STORE.get(
    activationConfigKey(credential.appId, credential.environmentId),
    "text",
  );
  if (raw === null) {
    throw new ActivationResolutionError(
      "Activation configuration has not been published for this Environment",
      { appId: credential.appId, environmentId: credential.environmentId },
    );
  }
  const config = ActivationConfigEnvelope.parse(JSON.parse(raw)).data;
  const forDefinition = config.bindings.filter(
    (binding) => binding.eventDefinitionId === eventDefinitionId,
  );
  if (forDefinition.length === 0) {
    throw new ActivationResolutionError(
      "No Experiment Run uses this Event Definition for Activation",
      {
        eventDefinitionId,
        boundEventDefinitionIds: distinct(config.bindings, "eventDefinitionId"),
      },
    );
  }
  const bindings = forDefinition.filter((binding) => binding.idType === event.idType);
  if (bindings.length === 0) {
    throw new ActivationResolutionError(
      "Activation Entity type does not match any Experiment Run using this Event Definition",
      { receivedIdType: event.idType, expectedIdTypes: distinct(forDefinition, "idType") },
    );
  }

  const assignments = await loadAssignments(env, credential.appId, event.idType, identity);
  /**
   * Attribution is by the Run the Entity was first exposed under, not by the
   * live Run (ADR-0006). A holdover keeps its prior Variant and its rows stay
   * attached to its own Run, so the binding that measures it is the one
   * published for THAT Run — and analysis discards any activation row whose
   * `run_id` is foreign to the Run being analyzed, so stamping the live Run
   * would produce a row nothing can ever join.
   */
  const bindingByRun = new Map(bindings.map((binding) => [binding.runId, binding]));
  const exposedBindings = Object.entries(assignments).flatMap(([experimentId, located]) => {
    const binding = bindingByRun.get(located.assignment.runId);
    return binding?.experimentId === experimentId ? [{ binding, ...located }] : [];
  });
  if (exposedBindings.length === 0) {
    throw new ActivationResolutionError(
      "No Experiment Run using this Event Definition has an Exposure for this Entity",
      {
        assignedRunIds: Object.values(assignments).map((located) => located.assignment.runId),
        boundRunIds: bindings.map((binding) => binding.runId),
      },
    );
  }
  const sourceId =
    env.SPLITCH_SOURCE_ID ?? (env.SPLITCH_PLATFORM_TARGET === "local" ? "local" : null);
  if (!sourceId) throw new ActivationResolutionError("Activation source identity is unavailable");
  const liveRunIds = await loadLiveRunIds(
    env,
    credential,
    exposedBindings.map(({ binding }) => binding.experimentId),
  );
  const serverReceivedAt = new Date().toISOString();
  return Promise.all(
    exposedBindings.map(({ assignment, binding, targetingKeyHash }) =>
      activationRow(
        credential,
        event,
        { entityFamilyHash: identity.entityFamilyHash, targetingKeyHash },
        binding,
        assignment.variant,
        liveRunIds.get(binding.experimentId) !== binding.runId,
        sourceId,
        serverReceivedAt,
      ),
    ),
  );
}

function distinct(bindings: readonly ActivationBindingKV[], field: keyof ActivationBindingKV) {
  return [...new Set(bindings.map((binding) => binding[field]))];
}

async function loadAssignments(
  env: Env,
  appId: string,
  idType: string,
  identity: { targetingKeyHashes: readonly string[] },
): Promise<Record<string, LocatedAssignment>> {
  const assignmentsKv = env.ASSIGNMENTS_KV;
  if (!assignmentsKv) {
    throw new ActivationResolutionError("Assignment store is unavailable");
  }
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
        throw new ActivationResolutionError(
          "Conflicting Assignment values across retained Entity identities",
          { experimentId },
        );
      }
      merged[experimentId] = { assignment, targetingKeyHash: value.targetingKeyHash };
    }
  }
  return merged;
}

/**
 * The live Run pointer per Experiment, so `is_holdover` reports what the row
 * actually is. The key is absent when the Experiment has no live Run, which
 * makes every remaining Entity a holdover — the same answer, without a default
 * standing in for a missing read.
 */
async function loadLiveRunIds(
  env: Env,
  credential: MetricEventCredentialScope,
  experimentIds: readonly string[],
): Promise<Map<string, string | null>> {
  const configStore = env.CONFIG_STORE;
  if (!configStore) {
    throw new ActivationResolutionError("Activation configuration store is unavailable");
  }
  const entries = await Promise.all(
    [...new Set(experimentIds)].map(async (experimentId): Promise<[string, string | null]> => {
      const raw = await configStore.get(
        liveRunKey(credential.appId, credential.environmentId, experimentId),
        "text",
      );
      if (raw === null) return [experimentId, null];
      return [experimentId, LiveRunEnvelope.parse(JSON.parse(raw)).data.runId];
    }),
  );
  return new Map(entries);
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
  isHoldover: boolean,
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
    is_holdover: isHoldover ? 1 : 0,
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
