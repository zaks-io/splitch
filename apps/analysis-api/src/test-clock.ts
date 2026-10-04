import { afterEach, beforeEach, vi } from "vitest";

// Results fixtures describe July 2026 Runs. Pin their read time so real
// retention checks do not change their meaning as wall-clock time advances.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-08-15T00:00:00.000Z");
});
afterEach(() => vi.useRealTimers());
