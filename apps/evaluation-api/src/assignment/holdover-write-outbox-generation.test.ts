import { expect, it } from "vitest";
import type { HashedAssignmentPutInput } from "./assignment-store";
import { runHoldoverWriteAlarm, ensureHoldoverWriteJob } from "./holdover-write-outbox-ensure";
import { basePut, MemoryStorage } from "./holdover-write-outbox-test-fixtures";

it("retries with the sealed generation and cannot relabel stale work", async () => {
  const storage = new MemoryStorage();
  let currentVersion = "v1";
  const calls: HashedAssignmentPutInput[] = [];
  const put = {
    async putHashed(input: HashedAssignmentPutInput) {
      calls.push(input);
      if (calls.length === 1) throw new Error("forced first attempt failure");
      if (input.identityVersion !== currentVersion) throw new Error("stale identity generation");
      return { status: "stored" as const };
    },
  };
  await expect(ensureHoldoverWriteJob(storage, put, basePut, 1_000)).resolves.toEqual({
    status: "owned",
  });
  currentVersion = "v2";

  await runHoldoverWriteAlarm(storage, put, storage.alarms[0] ?? 2_000);

  expect(calls.map((call) => call.identityVersion)).toEqual(["v1", "v1"]);
  expect(storage.job).toMatchObject({ status: "pending", identityVersion: "v1" });
});
