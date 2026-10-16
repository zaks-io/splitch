import { inspect } from "node:util";
import { appScope } from "@splitch/db";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import { createWorkerFaultReporter, serializeFault } from "@splitch/observability/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runApprovalRequestArchival } from "../src/approval-archive";
import { type Harness, ids } from "../src/config-store-harness-core";
import { approvalRowCounts, seedApprovalArchiveFixture } from "./approval-archive-fixture";
import { MemoryApprovalArchiveStore } from "./approval-archive-test-store";
import { makePoolHarness } from "./config-store-pool-harness";

const captureMessage = vi.fn();
const consoleError = vi.fn();
let h: Harness;

beforeEach(async () => {
  h = await makePoolHarness();
  captureMessage.mockReset();
  consoleError.mockReset();
  vi.spyOn(console, "error").mockImplementation(consoleError);
  __setSentryModuleForTests({ captureMessage } as unknown as Parameters<
    typeof __setSentryModuleForTests
  >[0]);
});

afterEach(async () => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
  await h.dispose();
});

describe("Worker faults from local D1", () => {
  it("retains the real D1 bind token while withholding the rejected value", async () => {
    const error = await rejected(() => h.d1.prepare("SELECT ?").bind(["bindcanary"]).all());

    expect(error).toBeInstanceOf(Error);
    expect(inspectAll(error)).toContain("D1_TYPE_ERROR");
    expect(inspectAll(error)).toContain("bindcanary");

    const fault = serializeFault(error);
    expect(fault).toContain("D1_TYPE_ERROR");
    expect(fault).not.toContain("bindcanary");
    await expectSafeSinks(fault, ["D1_TYPE_ERROR"], ["bindcanary"]);
  });

  it("keeps the first real archive SQL and D1 token when 25 candidate failures exceed the budget", async () => {
    const requestIds = Array.from(
      { length: 25 },
      (_, index) => `apr_01J${String(index).padStart(21, "0")}AA`,
    );
    for (const id of requestIds) {
      await seedApprovalArchiveFixture(h.d1, { id, resolvedAt: "2026-05-01T12:00:00.000Z" });
    }
    const store = new MemoryApprovalArchiveStore();
    const firstId = requestIds[0];
    if (!firstId) throw new Error("Archive regression requires a first candidate");
    const candidates = await h.repo.approvals.listArchiveCandidates(
      "2026-05-09T12:00:00.000Z",
      100,
    );
    expect(candidates.map(({ id }) => id)).toEqual(requestIds);

    // Removing the real table makes Drizzle wrap the local driver's failure.
    await h.d1
      .prepare("ALTER TABLE approval_reviews RENAME TO approval_reviews_fault_canary")
      .run();
    try {
      const error = await rejected(() =>
        runApprovalRequestArchival({
          repo: h.repo,
          store,
          now: new Date("2026-08-07T12:00:00.000Z"),
        }),
      );
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.errors).toHaveLength(25);
      const first = aggregate.errors[0].cause;
      const query = h.repo.approvals.listReviews(appScope(ids.appId), firstId).toSQL().sql;
      expect(first.query).toBe(query);
      expect(first.params).toEqual([ids.appId, firstId]);
      expect(first.message).toContain(firstId);
      expect(first.stack).toContain(firstId);
      expect(inspectAll(first.cause)).toContain("D1_ERROR");
      expect(first.cause.cause.message).toContain("no such table: approval_reviews");
      expect(inspectAll(error)).toContain("no such table: approval_reviews");

      const fault = serializeFault(error);
      expect(fault).toContain(`Failed query: ${query}`);
      expect(fault).toContain("D1_ERROR");
      // Root plus seven complete four-node chains leave three slots for the
      // eighth chain, omitting its last cause and the remaining 17 candidates.
      expect(fault).toContain("[18 more errors omitted]");
      expect(new TextEncoder().encode(fault).length).toBeLessThanOrEqual(8 * 1024);
      await expectSafeSinks(
        fault,
        [query, "D1_ERROR", "more errors omitted"],
        [...requestIds, ids.appId, "params:", "no such table: approval_reviews"],
      );
      expect(store.appendCalls).toBe(0);
    } finally {
      await h.d1
        .prepare("ALTER TABLE approval_reviews_fault_canary RENAME TO approval_reviews")
        .run();
    }

    for (const requestId of requestIds) {
      expect(await approvalRowCounts(h.d1, ids.appId, requestId)).toEqual({
        requests: 1,
        reviews: 2,
      });
    }
  });
});

async function rejected(action: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the real local D1 operation to fail");
}

async function expectSafeSinks(
  fault: string | undefined,
  retained: string[],
  withheld: string[],
): Promise<void> {
  const waits: Promise<unknown>[] = [];
  createWorkerFaultReporter(
    { SENTRY_DSN: "https://example@sentry.io/1" },
    { surface: "control-plane-api", waitUntil: (promise) => waits.push(promise) },
  )("approval_request_archive_failed", { fault });
  await Promise.all(waits);
  expect(captureMessage).toHaveBeenCalledOnce();
  expect(consoleError).toHaveBeenCalledOnce();
  for (const sink of [captureMessage.mock.calls, consoleError.mock.calls]) {
    const output = inspectAll(sink);
    for (const diagnostic of retained) expect(output).toContain(diagnostic);
    for (const canary of withheld) expect(output).not.toContain(canary);
  }
}

function inspectAll(value: unknown): string {
  return inspect(value, {
    showHidden: true,
    depth: null,
    maxStringLength: null,
    maxArrayLength: null,
  });
}
