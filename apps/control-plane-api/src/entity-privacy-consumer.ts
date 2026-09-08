import {
  assertStoreIdentity,
  callAssignmentPrivacy,
  callStorePrivacy,
  callStorePrivacyPage,
  type EntityPrivacyConsumerInput,
  type EntityPrivacyExportPage,
  type EntityPrivacyStoreResult,
  type ResolvedEntityPrivacyInput,
} from "./entity-privacy-service-client";

export interface EntityPrivacyConsumer {
  resolveIdentity(input: EntityPrivacyConsumerInput): Promise<EntityPrivacyStoreResult>;
  exportAssignmentsPage(
    input: ResolvedEntityPrivacyInput,
    cursor: string | null,
    limit: number,
  ): Promise<EntityPrivacyExportPage>;
  exportAnalysisPage(
    input: ResolvedEntityPrivacyInput,
    cursor: string | null,
    limit: number,
  ): Promise<EntityPrivacyExportPage>;
  exportEventsPage(
    input: ResolvedEntityPrivacyInput,
    cursor: string | null,
    limit: number,
  ): Promise<EntityPrivacyExportPage>;
  suppressAnalysis(
    input: EntityPrivacyConsumerInput | ResolvedEntityPrivacyInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  suppressEvents(
    input: EntityPrivacyConsumerInput | ResolvedEntityPrivacyInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  deleteAssignments(
    input: EntityPrivacyConsumerInput | ResolvedEntityPrivacyInput,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  deleteAnalysis(
    input: EntityPrivacyConsumerInput | ResolvedEntityPrivacyInput,
    identity: EntityPrivacyStoreResult,
    deleteBeforeTs: string,
  ): Promise<EntityPrivacyStoreResult>;
  deleteEvents(
    input: EntityPrivacyConsumerInput | ResolvedEntityPrivacyInput,
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
    async resolveIdentity(input) {
      const page = await callAssignmentPrivacy(
        evaluation,
        "entity_assignment_privacy_export",
        input,
        undefined,
        { cursor: null, limit: 1 },
      );
      return {
        appId: page.appId,
        idType: page.idType,
        targetingKeyHashes: page.targetingKeyHashes,
        entityFamilyHash: page.entityFamilyHash,
      };
    },
    async exportAssignmentsPage(input, cursor, limit) {
      return exportPage(
        await callAssignmentPrivacy(
          evaluation,
          "entity_assignment_privacy_export",
          input,
          undefined,
          { cursor, limit },
        ),
        "Assignment export",
      );
    },
    async exportAnalysisPage(input, cursor, limit) {
      const analytics = await callStorePrivacyPage(
        analysis,
        "entity_analysis_privacy_export",
        input,
        input,
        { cursor, limit },
      );
      assertStoreIdentity(input, analytics, "analysis export");
      return exportPage(analytics, "Analysis export");
    },
    async exportEventsPage(input, cursor, limit) {
      const events = await callStorePrivacyPage(
        eventIngest,
        "entity_event_privacy_export",
        input,
        input,
        { cursor, limit },
      );
      assertStoreIdentity(input, events, "Event export");
      return exportPage(events, "Event export");
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

function exportPage(result: EntityPrivacyStoreResult, operation: string): EntityPrivacyExportPage {
  if (
    !Array.isArray(result.records) ||
    !Array.isArray(result.proofs) ||
    !(result.nextCursor === null || typeof result.nextCursor === "string")
  ) {
    throw new Error(`control-plane-api: ${operation} returned an invalid page`);
  }
  return {
    ...result,
    records: result.records,
    proofs: result.proofs,
    nextCursor: result.nextCursor,
  };
}
