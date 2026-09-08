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
  suppressAnalysis(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  suppressEvents(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  deleteAssignments(
    input: EntityPrivacyConsumerInput,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  deleteAnalysis(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  deleteEvents(
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
    async suppressAnalysis(input, identity, deleteBeforeTs) {
      const analytics = await callStorePrivacy(
        analysis,
        "entity_analysis_privacy_suppress",
        input,
        identity,
        deleteBeforeTs,
      );
      assertStoreIdentity(identity, analytics, "analysis suppression");
      return analytics;
    },
    async suppressEvents(input, identity, deleteBeforeTs) {
      const events = await callStorePrivacy(
        eventIngest,
        "entity_event_privacy_suppress",
        input,
        identity,
        deleteBeforeTs,
      );
      assertStoreIdentity(identity, events, "Event suppression");
      return events;
    },
    async deleteAssignments(input, deleteBeforeTs) {
      return callAssignmentPrivacy(
        evaluation,
        "entity_assignment_privacy_delete",
        input,
        deleteBeforeTs,
      );
    },
    async deleteAnalysis(input, identity, deleteBeforeTs) {
      const analytics = await callStorePrivacy(
        analysis,
        "entity_analysis_privacy_delete",
        input,
        identity,
        deleteBeforeTs,
      );
      assertStoreIdentity(identity, analytics, "analysis deletion");
      return analytics;
    },
    async deleteEvents(input, identity, deleteBeforeTs) {
      const events = await callStorePrivacy(
        eventIngest,
        "entity_event_privacy_delete",
        input,
        identity,
        deleteBeforeTs,
      );
      assertStoreIdentity(identity, events, "Event deletion");
      return events;
    },
  };
}
