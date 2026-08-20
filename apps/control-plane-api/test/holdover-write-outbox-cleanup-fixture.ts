import type { HoldoverWriteOutboxCleanup } from "../src/holdover-write-outbox-cleanup";

export const noOpHoldoverWriteOutboxCleanup: HoldoverWriteOutboxCleanup = {
  prepare: async () => undefined,
  finalize: async () => undefined,
  cancel: async () => undefined,
  delete: async () => undefined,
};
