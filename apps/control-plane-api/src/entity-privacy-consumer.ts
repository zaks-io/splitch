import {
  assertStoreIdentity,
  callAssignmentPrivacy,
  callStorePrivacy,
  type EntityPrivacyConsumerInput,
  type EntityPrivacyStoreResult,
  exportedStore,
} from "./entity-privacy-service-client";

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
        exportArtifact: {
          schemaVersion: "entity-privacy-export-v1",
          appId: assignments.appId,
          idType: assignments.idType,
          targetingKeyHashes: assignments.targetingKeyHashes,
          entityFamilyHash: assignments.entityFamilyHash,
          stores: [
            exportedStore("assignments", assignments),
            exportedStore("analysis", analytics),
            exportedStore("event-ingest", events),
          ],
        },
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
        callAssignmentPrivacy(
          evaluation,
          "entity_assignment_privacy_delete",
          input,
          deleteBeforeTs,
        ),
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
