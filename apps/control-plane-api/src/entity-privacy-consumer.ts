import {
  assertStoreIdentity,
  callAssignmentPrivacy,
  callStorePrivacy,
  callStorePrivacyPage,
  type EntityPrivacyConsumerInput,
  type EntityPrivacyPageInput,
  type EntityPrivacyStoreResult,
} from "./entity-privacy-service-client";

export interface EntityPrivacyConsumer {
  exportEntity(input: EntityPrivacyConsumerInput): Promise<EntityPrivacyStoreResult>;
  exportAnalysisPage(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    page: EntityPrivacyPageInput,
  ): Promise<EntityPrivacyStoreResult>;
  exportEventsPage(
    input: EntityPrivacyConsumerInput,
    identity: EntityPrivacyStoreResult,
    page: EntityPrivacyPageInput,
  ): Promise<EntityPrivacyStoreResult>;
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
      return callAssignmentPrivacy(evaluation, "entity_assignment_privacy_export", input);
    },
    async exportAnalysisPage(input, identity, page) {
      const analytics = await callStorePrivacyPage(
        analysis,
        "entity_analysis_privacy_export",
        input,
        identity,
        page,
      );
      assertStoreIdentity(identity, analytics, "analysis export");
      return analytics;
    },
    async exportEventsPage(input, identity, page) {
      const events = await callStorePrivacyPage(
        eventIngest,
        "entity_event_privacy_export",
        input,
        identity,
        page,
      );
      assertStoreIdentity(identity, events, "Event export");
      return events;
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
