import { getRoute } from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";

interface EntityPrivacyStoreResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  records?: readonly {
    targetingKeyHash: string;
    assignments: Record<string, { runId: string; variant: string }>;
  }[];
  deletedKeyCount?: number;
  deletedWriterCount?: number;
  proofs?: readonly string[];
}

export interface EntityPrivacyConsumer {
  exportEntity(input: EntityPrivacyConsumerInput): Promise<EntityPrivacyStoreResult>;
  suppressEntity(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<void>;
  deleteEntity(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
}

interface EntityPrivacyConsumerInput {
  appId: string;
  idType: string;
  targetingKey: string;
  actorId: string;
  orgId: string | null;
  requestId: string;
}

export class EntityPrivacyConsumerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityPrivacyConsumerError";
  }
}

export function createEntityPrivacyConsumer(
  evaluation: Fetcher | undefined,
  analysis: Fetcher | undefined,
  eventIngest: Fetcher | undefined,
): EntityPrivacyConsumer | undefined {
  if (!evaluation || !analysis || !eventIngest) return undefined;
  return {
    async exportEntity(input) {
      const assignments = await callAssignmentPrivacy(
        evaluation,
        "entity_assignment_privacy_export",
        input,
      );
      const [analytics, events] = await Promise.all([
        callStorePrivacy(analysis, "entity_analysis_privacy_export", input, assignments),
        callStorePrivacy(eventIngest, "entity_event_privacy_export", input, assignments),
      ]);
      assertStoreIdentity(assignments, analytics, "export");
      assertStoreIdentity(assignments, events, "Event export");
      return {
        ...assignments,
        proofs: [...(analytics.proofs ?? []), ...(events.proofs ?? [])],
      };
    },
    async suppressEntity(input, identity, deleteBeforeTs) {
      const [analytics, events] = await Promise.all([
        callStorePrivacy(
          analysis,
          "entity_analysis_privacy_suppress",
          input,
          identity,
          deleteBeforeTs,
        ),
        callStorePrivacy(
          eventIngest,
          "entity_event_privacy_suppress",
          input,
          identity,
          deleteBeforeTs,
        ),
      ]);
      assertStoreIdentity(identity, analytics, "analysis suppression");
      assertStoreIdentity(identity, events, "Event suppression");
    },
    async deleteEntity(input, identity, deleteBeforeTs) {
      const [assignments, analytics, events] = await Promise.all([
        callAssignmentPrivacy(evaluation, "entity_assignment_privacy_delete", input),
        callStorePrivacy(
          analysis,
          "entity_analysis_privacy_delete",
          input,
          identity,
          deleteBeforeTs,
        ),
        callStorePrivacy(
          eventIngest,
          "entity_event_privacy_delete",
          input,
          identity,
          deleteBeforeTs,
        ),
      ]);
      assertStoreIdentity(identity, assignments, "Assignment deletion");
      assertStoreIdentity(identity, analytics, "analysis deletion");
      assertStoreIdentity(identity, events, "Event deletion");
      return {
        ...assignments,
        proofs: [
          ...(assignments.proofs ?? []),
          ...(analytics.proofs ?? []),
          ...(events.proofs ?? []),
        ],
      };
    },
  };
}

async function callAssignmentPrivacy(
  evaluation: Fetcher,
  operationId: "entity_assignment_privacy_export" | "entity_assignment_privacy_delete",
  input: EntityPrivacyConsumerInput,
): Promise<EntityPrivacyStoreResult> {
  const route = getRoute(operationId);
  if (!route) {
    throw new EntityPrivacyConsumerError(`control-plane-api: ${operationId} is not registered`);
  }
  const response = await evaluation.fetch(
    delegatedRequest(
      route,
      {
        operation: route.operationId,
        actorId: input.actorId,
        orgId: input.orgId,
        appId: input.appId,
        environmentId: null,
      },
      {
        params: { appId: input.appId },
        body: { idType: input.idType, targetingKey: input.targetingKey },
        requestId: input.requestId,
      },
    ),
  );
  if (!response.ok) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as EntityPrivacyStoreResult;
  if (!Array.isArray(body.targetingKeyHashes) || body.appId !== input.appId) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} returned an invalid body`,
    );
  }
  if (typeof body.entityFamilyHash !== "string" || body.entityFamilyHash.length === 0) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} omitted Entity family identity`,
    );
  }
  if (
    operationId === "entity_assignment_privacy_delete" &&
    (body.deletedKeyCount !== body.targetingKeyHashes.length ||
      body.deletedWriterCount !== body.targetingKeyHashes.length ||
      !Array.isArray(body.proofs) ||
      body.proofs.length !== body.targetingKeyHashes.length ||
      body.proofs.some((proof) => typeof proof !== "string" || proof.length === 0))
  ) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: entity_assignment_privacy_delete returned incomplete store proof",
    );
  }
  return body;
}

async function callStorePrivacy(
  service: Fetcher,
  operationId:
    | "entity_analysis_privacy_export"
    | "entity_analysis_privacy_suppress"
    | "entity_analysis_privacy_delete"
    | "entity_event_privacy_export"
    | "entity_event_privacy_suppress"
    | "entity_event_privacy_delete",
  input: EntityPrivacyConsumerInput,
  identity: EntityPrivacyStoreResult,
  deleteBeforeTs?: string,
): Promise<EntityPrivacyStoreResult> {
  const route = getRoute(operationId);
  if (!route)
    throw new EntityPrivacyConsumerError(`control-plane-api: ${operationId} is not registered`);
  const response = await service.fetch(
    delegatedRequest(
      route,
      {
        operation: route.operationId,
        actorId: input.actorId,
        orgId: input.orgId,
        appId: input.appId,
        environmentId: null,
      },
      {
        params: { appId: input.appId },
        body: {
          idType: input.idType,
          targetingKeyHashes: identity.targetingKeyHashes,
          entityFamilyHash: identity.entityFamilyHash,
          ...(deleteBeforeTs ? { deleteBeforeTs } : {}),
        },
        requestId: input.requestId,
      },
    ),
  );
  if (!response.ok) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} failed with HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as EntityPrivacyStoreResult;
  if (!Array.isArray(body.targetingKeyHashes) || !Array.isArray(body.proofs)) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} returned an invalid body`,
    );
  }
  const requiredProofs = requiredStoreProofs(operationId);
  if (requiredProofs.some((prefix) => !body.proofs?.some((proof) => proof.startsWith(prefix)))) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} returned incomplete store proof`,
    );
  }
  return body;
}

function requiredStoreProofs(operationId: string): readonly string[] {
  switch (operationId) {
    case "entity_analysis_privacy_suppress":
      return ["entity_deletions:"];
    case "entity_analysis_privacy_export":
    case "entity_analysis_privacy_delete":
      return [
        "tinybird:raw_events:",
        "tinybird:metric_events:",
        "tinybird:deduped_exposures:",
        "tinybird:deduped_metric_events_state:",
      ];
    case "entity_event_privacy_export":
      return ["metric-event-outbox-inventory:", "evaluation-commit-outbox-inventory:"];
    case "entity_event_privacy_suppress":
      return ["metric-event-queue-suppression:"];
    case "entity_event_privacy_delete":
      return [
        "metric-event-outbox-redaction:",
        "evaluation-commit-outbox-redaction:",
        "metric-event-queue:",
      ];
    default:
      throw new EntityPrivacyConsumerError(
        `control-plane-api: unknown store operation ${operationId}`,
      );
  }
}

function assertStoreIdentity(
  expected: EntityPrivacyStoreResult,
  actual: EntityPrivacyStoreResult,
  operation: string,
): void {
  if (
    expected.appId !== actual.appId ||
    expected.idType !== actual.idType ||
    expected.entityFamilyHash !== actual.entityFamilyHash ||
    expected.targetingKeyHashes.length !== actual.targetingKeyHashes.length ||
    expected.targetingKeyHashes.some((hash, index) => hash !== actual.targetingKeyHashes[index])
  ) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: Entity identity changed during ${operation}`,
    );
  }
}
