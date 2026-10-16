import { inspect } from "node:util";
import { envScope, type Repository } from "@splitch/db";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
  serializeFault,
} from "@splitch/observability/worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIntegrationSnapshot } from "./integration-snapshot";

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
});

describe("Convex integration snapshot", () => {
  it("withholds a customer allocation-map key from real ZodError reports", async () => {
    const canary = "customer-allocation-key-canary";
    const row = flag("flag_1", "checkout");
    const listRunsByIds = vi.fn().mockResolvedValue([
      {
        id: "run_1",
        experimentId: "exp_1",
        salt: "salt",
        allocation: JSON.stringify({ [canary]: "invalid-share" }),
        variantSet: '[{"id":"variant_flag_1","name":"control","value":false}]',
        targetingRules: "[]",
        configHash: "sha256:run-1",
        startedAt: "2026-08-30T00:00:00.000Z",
      },
    ]);
    const repo = {
      flags: {
        flags: { findMany: vi.fn().mockResolvedValue([row]) },
        listFlagConfigsByFlagIds: vi.fn().mockResolvedValue([config(row)]),
        listVariantsForFlags: vi.fn().mockResolvedValue(new Map([[row.id, [variant(row.id)]]])),
        listTargetingRulesByFlagIds: vi.fn().mockResolvedValue([]),
        listSegmentsByIds: vi.fn().mockResolvedValue([]),
      },
      experiments: {
        listRunningExperimentsForFlags: vi.fn().mockResolvedValue([
          {
            id: "exp_1",
            flagId: row.id,
            targetingKeyField: "userId",
            targetingKeyType: "user",
            status: "running",
            liveRunId: "run_1",
          },
        ]),
        listRunsByIds,
      },
    } as unknown as Repository;
    const failure = await buildIntegrationSnapshot(
      repo,
      envScope("app_1", "environment_1"),
      9,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe("ZodError");
    expect((failure as Error).message).toContain(canary);
    expect(failure).toMatchObject({
      issues: [expect.objectContaining({ path: ["allocation", canary] })],
    });
    expect(listRunsByIds).toHaveBeenCalledOnce();

    const captureMessage = vi.fn();
    const addBreadcrumb = vi.fn();
    __setSentryModuleForTests({ captureMessage, addBreadcrumb } as unknown as Parameters<
      typeof __setSentryModuleForTests
    >[0]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    const env = { SENTRY_DSN: "https://example@sentry.io/1" };
    const options = {
      surface: "control-plane-api" as const,
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    };
    createWorkerFaultReporter(env, options)("integration_snapshot_failed", {
      fault: serializeFault(failure),
    });
    const observability = createWorkerObservability(env, options);
    for (const status of [500, 400]) {
      observability.onError?.({
        requestId: "req-integration-snapshot",
        status,
        code: status === 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST",
        cause: failure,
      });
    }
    await Promise.all(pending);
    expect(captureMessage).toHaveBeenCalledTimes(2);
    expect(addBreadcrumb).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledTimes(2);
    for (const calls of [
      captureMessage.mock.calls,
      addBreadcrumb.mock.calls,
      consoleError.mock.calls,
    ]) {
      const emitted = inspect(calls, {
        showHidden: true,
        depth: null,
        maxStringLength: null,
        maxArrayLength: null,
      });
      expect(emitted).toContain("ZodError: [message withheld]");
      expect(emitted).not.toContain(canary);
      expect(emitted).not.toContain("invalid-share");
    }
  });

  it("loads an Environment in fixed query groups instead of reading once per Flag", async () => {
    const flags = [flag("flag_1", "checkout"), flag("flag_2", "search")];
    const findMany = vi.fn().mockResolvedValue(flags);
    const listFlagConfigsByFlagIds = vi.fn().mockResolvedValue(flags.map(config));
    const listVariantsForFlags = vi
      .fn()
      .mockResolvedValue(new Map(flags.map((row) => [row.id, [variant(row.id)]])));
    const listTargetingRulesByFlagIds = vi.fn().mockResolvedValue([]);
    const listRunningExperimentsForFlags = vi.fn().mockResolvedValue([]);
    const listRunsByIds = vi.fn().mockResolvedValue([]);
    const listSegmentsByIds = vi.fn().mockResolvedValue([]);
    const repo = {
      flags: {
        flags: { findMany },
        listFlagConfigsByFlagIds,
        listVariantsForFlags,
        listTargetingRulesByFlagIds,
        listSegmentsByIds,
      },
      experiments: { listRunningExperimentsForFlags, listRunsByIds },
    } as unknown as Repository;

    const snapshot = await buildIntegrationSnapshot(repo, envScope("app_1", "environment_1"), 9);

    expect(snapshot.flags.map((row) => row.key)).toEqual(["checkout", "search"]);
    for (const read of [
      findMany,
      listFlagConfigsByFlagIds,
      listVariantsForFlags,
      listTargetingRulesByFlagIds,
      listRunningExperimentsForFlags,
      listRunsByIds,
      listSegmentsByIds,
    ])
      expect(read).toHaveBeenCalledOnce();
  });
});

function flag(id: string, key: string) {
  return { id, key };
}

function config(row: ReturnType<typeof flag>) {
  return {
    id: `config_${row.id}`,
    flagId: row.id,
    enabled: true,
    defaultVariantId: `variant_${row.id}`,
    availableVariantNames: '["control"]',
    rollout: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function variant(flagId: string) {
  return {
    id: `variant_${flagId}`,
    flagId,
    name: "control",
    value: "false",
    description: null,
  };
}
