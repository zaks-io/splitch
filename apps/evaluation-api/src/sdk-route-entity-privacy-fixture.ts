import { RecordingKv, StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import type { EntityAssignmentPrivacyHandlerDeps } from "./assignment/entity-assignment-privacy-handler";

/** Binding-door harness stub so route-surface mounting can register export/delete. */
export function stubEntityAssignmentPrivacy(): EntityAssignmentPrivacyHandlerDeps {
  return { assignmentsKv: new RecordingKv(), saltStore: new StaticSaltStore() };
}
