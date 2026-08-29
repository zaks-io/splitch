import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAppIdentityReset, purgeAppIdentityAssignments } from "./app-identity-reset";
import {
  APP_ID,
  ENTITY_A,
  ENTITY_B,
  ENTITY_C,
  entityName,
  RESET_ID,
  ResetHarness,
} from "./app-identity-reset-test-harness";

afterEach(() => vi.restoreAllMocks());

describe("App identity Assignment reset", () => {
  it("purges every Entity from durable status when begin returns no entities", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    const reset = new ResetHarness([ENTITY_A, ENTITY_B]);
    reset.kv.set(`assignment:${APP_ID}:user:${ENTITY_A.targetingKeyHash}`, "a");
    reset.kv.set(`assignment:${APP_ID}:device:${ENTITY_B.targetingKeyHash}`, "b");

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).resolves.toBe(
      "evaluation-assignments:kv=2;durable_inventory=empty;durable_objects=4",
    );

    expect(reset.entities).toEqual([]);
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_A)}`,
      `outbox:delete:${entityName(ENTITY_A)}:9000`,
      `writer:delete:${entityName(ENTITY_B)}`,
      `outbox:delete:${entityName(ENTITY_B)}:9000`,
    ]);
  });

  it("discovers and purges a settled direct writer that predates durable App inventory", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    const reset = new ResetHarness([]);
    reset.kv.set(`assignment:${APP_ID}:account:${ENTITY_C.targetingKeyHash}`, "winner");

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).resolves.toBe(
      "evaluation-assignments:kv=1;durable_inventory=empty;durable_objects=2",
    );

    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_C)}`,
      `outbox:delete:${entityName(ENTITY_C)}:9000`,
    ]);
    expect(reset.tombstonedWriters).toContain(entityName(ENTITY_C));
  });

  it("retains the durable Entity checkpoint when writer deletion fails, then resumes after restart", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(9_000).mockReturnValueOnce(12_000);
    const reset = new ResetHarness([ENTITY_A, ENTITY_B]);
    reset.writerDeleteFailures.set(entityName(ENTITY_B), 1);

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).rejects.toThrow(
      /Assignment writer purge returned HTTP 503/u,
    );
    expect(reset.entities).toEqual([ENTITY_B]);
    expect(reset.calls).not.toContain(`outbox:delete:${entityName(ENTITY_B)}:9000`);

    reset.calls.length = 0;
    const restartedEnv = reset.env();
    await expect(purgeAppIdentityAssignments(restartedEnv, APP_ID, RESET_ID)).resolves.toContain(
      "durable_inventory=empty",
    );
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_B)}`,
      `outbox:delete:${entityName(ENTITY_B)}:9000`,
    ]);
  });

  it("tombstones the writer before an outbox failure and prevents old-hash resurrection on retry", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);
    const reset = new ResetHarness([ENTITY_A]);
    reset.outboxDeleteFailures.set(entityName(ENTITY_A), 1);

    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).rejects.toThrow(
      /outbox purge returned HTTP 503/u,
    );
    expect(reset.entities).toEqual([ENTITY_A]);
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_A)}`,
      `outbox:delete:${entityName(ENTITY_A)}:9000`,
    ]);
    await expect(reset.putOldAssignment(ENTITY_A)).resolves.toMatchObject({ status: 409 });

    reset.calls.length = 0;
    await expect(purgeAppIdentityAssignments(reset.env(), APP_ID, RESET_ID)).resolves.toContain(
      "durable_inventory=empty",
    );
    expect(reset.calls).toEqual([
      `writer:delete:${entityName(ENTITY_A)}`,
      `outbox:delete:${entityName(ENTITY_A)}:9000`,
    ]);
  });

  it("keeps reset completion blocked until the durable cancellation reports done", async () => {
    const reset = new ResetHarness([]);
    reset.freeze();
    reset.cancelResponses.push(
      {
        cancelled: true,
        done: false,
        entities: [ENTITY_B],
        sagaPhase: "canceling",
      },
      { cancelled: true, done: true, entities: [], sagaPhase: null },
    );

    await expect(completeAppIdentityReset(reset.env(), APP_ID, RESET_ID, "app-v2")).rejects.toThrow(
      /cancellation is incomplete.*1 Entity checkpoint/u,
    );
    expect(reset.directKvDeletes).toBe(0);
    expect(reset.suppressed).toBe(true);

    await expect(
      completeAppIdentityReset(reset.env(), APP_ID, RESET_ID, "app-v2"),
    ).resolves.toBeUndefined();
    expect(reset.directKvDeletes).toBe(0);
    expect(reset.suppressed).toBe(false);
    expect(reset.phase).toBeNull();
    await expect(
      completeAppIdentityReset(reset.env(), APP_ID, RESET_ID, "app-v2"),
    ).resolves.toBeUndefined();
    expect(reset.completedResetId).toBe(RESET_ID);
  });
});
