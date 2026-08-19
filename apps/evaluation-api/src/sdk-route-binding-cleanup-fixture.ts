import type { HoldoverWriteOutboxCleanupDeps } from "./assignment/holdover-write-outbox-cleanup";

/** Binding-door harness stub so route-surface mounting can register cleanup. */
export function stubHoldoverWriteOutboxCleanup(): HoldoverWriteOutboxCleanupDeps {
  return {
    assignmentsKv: {
      async get() {
        return null;
      },
      async put() {
        return undefined;
      },
    },
    holdoverWriteOutbox: {
      idFromName(name: string) {
        return name as unknown as DurableObjectId;
      },
      get() {
        return {
          async fetch() {
            return Response.json({ ok: true });
          },
        };
      },
    },
  };
}
