import type { HoldoverWriteOutboxCleanup } from "../src/holdover-write-outbox-cleanup";

export const noOpHoldoverWriteOutboxCleanup: HoldoverWriteOutboxCleanup = {
  delete: async () => undefined,
};
