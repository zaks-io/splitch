import { getRoute } from "@splitch/contracts";
import { delegatedRequest } from "@splitch/worker-runtime";

interface EntityPrivacyStoreResult {
  appId: string;
  idType: string;
  targetingKeyHashes: readonly string[];
  records?: readonly {
    targetingKeyHash: string;
    assignments: Record<string, { runId: string; variant: string }>;
  }[];
  deletedKeyCount?: number;
}

export interface EntityPrivacyConsumer {
  exportEntity(input: EntityPrivacyConsumerInput): Promise<EntityPrivacyStoreResult>;
  deleteEntity(input: EntityPrivacyConsumerInput): Promise<EntityPrivacyStoreResult>;
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
): EntityPrivacyConsumer | undefined {
  if (!evaluation) return undefined;
  return {
    exportEntity: (input) =>
      callEntityPrivacy(evaluation, "entity_assignment_privacy_export", input),
    deleteEntity: (input) =>
      callEntityPrivacy(evaluation, "entity_assignment_privacy_delete", input),
  };
}

async function callEntityPrivacy(
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
  return body;
}
