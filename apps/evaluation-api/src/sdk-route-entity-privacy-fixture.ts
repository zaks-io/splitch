import { RecordingKv, StaticSaltStore } from "./assignment/assignment-store-test-fixtures";
import type { EntityAssignmentPrivacyHandlerDeps } from "./assignment/entity-assignment-privacy-handler";

/** Binding-door harness stub so route-surface mounting can register export/delete. */
export function stubEntityAssignmentPrivacy(): EntityAssignmentPrivacyHandlerDeps {
  return {
    assignmentsKv: new RecordingKv(),
    assignmentWriters: {
      idFromName: (name) => name as unknown as DurableObjectId,
      get: () => ({
        fetch: async () => Response.json({ deleted: true, proof: "assignment-do-tombstone-v1" }),
      }),
    },
    saltStore: new StaticSaltStore(),
  };
}
