import { getRoute } from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";

export interface EntityPrivacyStoreResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  entityFamilyHash: string;
  records?: readonly {
    targetingKeyHash: string;
    assignments: Record<string, { runId: string; variant: string }>;
    assignmentWriterAssignments: Record<string, { runId: string; variant: string }>;
  }[];
  deletedKeyCount?: number;
  deletedWriterCount?: number;
  deletedOutboxCount?: number;
  proofs?: readonly string[];
  nextCursor?: string | null;
}

export interface EntityPrivacyConsumerInput {
  appId: string;
  idType: string;
  targetingKey: string;
  actorId: string;
  orgId: string | null;
  requestId: string;
}

export interface EntityPrivacyPageInput {
  limit: number;
  cursor: string | null;
}

export class EntityPrivacyConsumerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntityPrivacyConsumerError";
  }
}

export async function callAssignmentPrivacy(
  evaluation: Fetcher,
  operationId: "entity_assignment_privacy_export" | "entity_assignment_privacy_delete",
  input: EntityPrivacyConsumerInput,
  deleteBeforeTs?: string,
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
        body: {
          idType: input.idType,
          targetingKey: input.targetingKey,
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
  assertAssignmentPrivacyProof(operationId, body);
  return body;
}

export async function callStorePrivacyPage(
  service: Fetcher,
  operationId: "entity_analysis_privacy_export" | "entity_event_privacy_export",
  input: EntityPrivacyConsumerInput,
  identity: EntityPrivacyStoreResult,
  page: EntityPrivacyPageInput,
): Promise<EntityPrivacyStoreResult> {
  return callStorePrivacyOperation(service, operationId, input, identity, page);
}

export async function callStorePrivacy(
  service: Fetcher,
  operationId:
    | "entity_analysis_privacy_suppress"
    | "entity_analysis_privacy_delete"
    | "entity_event_privacy_suppress"
    | "entity_event_privacy_delete",
  input: EntityPrivacyConsumerInput,
  identity: EntityPrivacyStoreResult,
  deleteBeforeTs: string,
): Promise<EntityPrivacyStoreResult> {
  return callStorePrivacyOperation(service, operationId, input, identity, { deleteBeforeTs });
}

async function callStorePrivacyOperation(
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
  operation:
    | EntityPrivacyPageInput
    | {
        deleteBeforeTs: string;
      },
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
          ...operation,
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
  if (operationId === "entity_event_privacy_export") {
    assertEventExportCardinality(body);
  }
  if (
    operationId.endsWith("_export") &&
    (!Array.isArray(body.records) ||
      (body.nextCursor !== null && typeof body.nextCursor !== "string"))
  ) {
    throw new EntityPrivacyConsumerError(
      `control-plane-api: ${operationId} returned an invalid page`,
    );
  }
  return body;
}

function assertEventExportCardinality(body: EntityPrivacyStoreResult): void {
  if (!Array.isArray(body.records) || !Array.isArray(body.proofs)) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: entity_event_privacy_export omitted records",
    );
  }
  const counts = body.proofs.map((proof) => /^.+-inventory:rows=(\d+)$/u.exec(proof));
  if (
    counts.some((match) => match === null) ||
    counts.reduce((sum, match) => sum + Number(match?.[1] ?? Number.NaN), 0) !== body.records.length
  ) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: entity_event_privacy_export returned inconsistent cardinality proof",
    );
  }
}

export function assertStoreIdentity(
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

function assertAssignmentPrivacyProof(
  operationId: "entity_assignment_privacy_export" | "entity_assignment_privacy_delete",
  body: EntityPrivacyStoreResult,
): void {
  if (operationId === "entity_assignment_privacy_export") {
    if (
      !Array.isArray(body.records) ||
      !Array.isArray(body.proofs) ||
      body.proofs.length !== body.targetingKeyHashes.length * 2 ||
      body.records.some(
        (record) => !isRecord(record.assignments) || !isRecord(record.assignmentWriterAssignments),
      )
    ) {
      throw new EntityPrivacyConsumerError(
        "control-plane-api: entity_assignment_privacy_export returned incomplete store proof",
      );
    }
    return;
  }
  if (
    body.deletedKeyCount !== body.targetingKeyHashes.length ||
    body.deletedWriterCount !== body.targetingKeyHashes.length ||
    body.deletedOutboxCount !== body.targetingKeyHashes.length ||
    !Array.isArray(body.proofs) ||
    body.proofs.length !== body.targetingKeyHashes.length * 2 ||
    body.proofs.some((proof) => typeof proof !== "string" || proof.length === 0)
  ) {
    throw new EntityPrivacyConsumerError(
      "control-plane-api: entity_assignment_privacy_delete returned incomplete store proof",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
