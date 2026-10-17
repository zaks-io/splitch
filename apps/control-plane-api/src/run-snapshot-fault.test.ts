import { inspect } from "node:util";
import { __setSentryModuleForTests } from "@splitch/observability/sentry-module";
import {
  createWorkerFaultReporter,
  createWorkerObservability,
} from "@splitch/observability/worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRow } from "./experiment-model";
import { shipCommittedRunSnapshot } from "./run-snapshot";

const scope = { appId: "app_1", environmentId: "env_prod" };

afterEach(() => {
  __setSentryModuleForTests(undefined);
  vi.restoreAllMocks();
});

describe("Run Snapshot fault detail", () => {
  it("withholds a native multiline parser excerpt from every serialized sink", async () => {
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
    const report = createWorkerFaultReporter(env, options);
    const observability = createWorkerObservability(env, options);
    const onFault = vi.fn((detail: Record<string, unknown>, cause: unknown) => {
      report("run_snapshot_ship_failed", detail);
      observability.onError?.({
        requestId: "req-snapshot-fault",
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        cause,
      });
      observability.onError?.({
        requestId: "req-snapshot-breadcrumb",
        code: "BAD_REQUEST",
        status: 400,
        cause,
      });
    });
    const fetch = vi.fn();
    expect(
      await shipCommittedRunSnapshot(
        { onFault, fetch },
        run({ variantSet: "x\n    at leakprobe" }),
        scope,
        [],
        "now",
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(onFault).toHaveBeenCalledOnce();
    const [detail, cause] = onFault.mock.calls[0] ?? [];
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).cause).toBeInstanceOf(SyntaxError);
    expect(((cause as Error).cause as SyntaxError).message).toContain("leakprobe");
    expect(detail?.fault).toContain("SyntaxError: [message withheld]");
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
      expect(emitted).toContain("SyntaxError: [message withheld]");
      expect(emitted).not.toContain("leakprobe");
      expect(emitted).not.toContain("Run variantSet is unparseable");
    }
  });

  it("preserves the nested ship failure in the fault sink", async () => {
    const onFault = vi.fn();
    const underlying = new Error("snapshot connection interrupted");
    const shipped = await shipCommittedRunSnapshot(
      {
        apiUrl: "https://api.tinybird.test",
        token: "test-token",
        fetch: () => Promise.reject(underlying),
        onFault,
      },
      run(),
      scope,
      [],
      "now",
    );
    expect(shipped).toBe(false);
    const fault = onFault.mock.calls[0]?.[0]?.fault;
    expect(fault).not.toContain("Tinybird Run Snapshot append failed");
    expect(fault).toContain("Error: [message withheld]");
    expect(fault).not.toContain(underlying.message);
  });
});

describe("shipCommittedRunSnapshot faults", () => {
  const delivery = (overrides: Record<string, unknown>) => ({
    apiUrl: "https://tinybird.local",
    token: "token",
    ...overrides,
  });

  it("routes a ship failure to onFault with the Run identifiers", async () => {
    const onFault = vi.fn();
    const shipped = await shipCommittedRunSnapshot(
      delivery({ fetch: () => Promise.reject(new Error("boom")), onFault }),
      run(),
      scope,
      [],
      "now",
    );
    expect(shipped).toBe(false);
    expect(onFault).toHaveBeenCalledOnce();
    const [detail] = onFault.mock.calls[0] ?? [];
    expect(detail).toMatchObject({
      appId: "app_1",
      environmentId: "env_prod",
      experimentId: "exp_1",
      runId: "run_1",
    });
  });

  it("does not call onFault on success", async () => {
    const onFault = vi.fn();
    const shipped = await shipCommittedRunSnapshot(
      delivery({
        fetch: () => Promise.resolve(Response.json({ successful_rows: 1, quarantined_rows: 0 })),
        onFault,
      }),
      run(),
      scope,
      [],
      "now",
    );
    expect(shipped).toBe(true);
    expect(onFault).not.toHaveBeenCalled();
  });

  it("treats a 2xx that quarantined the row as a ship failure", async () => {
    const onFault = vi.fn();
    const shipped = await shipCommittedRunSnapshot(
      delivery({
        fetch: () => Promise.resolve(Response.json({ successful_rows: 0, quarantined_rows: 1 })),
        onFault,
      }),
      run(),
      scope,
      [],
      "now",
    );
    expect(shipped).toBe(false);
    expect(onFault.mock.calls[0]?.[0]).toMatchObject({
      fault: expect.stringContaining("[message withheld]"),
    });
  });

  it("a throwing fault sink still reports the ship as failed", async () => {
    const shipped = await shipCommittedRunSnapshot(
      delivery({
        fetch: () => Promise.reject(new Error("boom")),
        onFault: () => {
          throw new Error("sink down");
        },
      }),
      run(),
      scope,
      [],
      "now",
    );
    expect(shipped).toBe(false);
  });
});

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run_1",
    appId: "app_1",
    environmentId: "env_prod",
    experimentId: "exp_1",
    runNumber: 1,
    status: "running",
    targetingKeyField: "userId",
    targetingKeyType: "user",
    activationMetricId: null,
    salt: "salt",
    allocation: '{"control":40,"treatment":60}',
    variantSet:
      '[{"id":"variant_control","name":"control"},{"id":"variant_treatment","name":"treatment"}]',
    controlVariantId: "variant_control",
    targetingRules: "[]",
    confidenceLevel: 0.95,
    horizon: "sequential",
    targetN: null,
    sampleSizeLocked: 2000,
    analysisVersion: null,
    targetNSource: null,
    plannedDurationDays: null,
    plannedDurationOverrideReason: null,
    preRegistration: null,
    decisionFamily: '[{"metricId":"metric_1"}]',
    guardrailDecisions: "[]",
    metricVarianceConfig: "[]",
    configHash: "sha256:run-1",
    startedAt: "2026-08-03T12:00:00.000Z",
    endedAt: null,
    startReason: null,
    endReason: null,
    createdAt: "2026-08-03T12:00:00.000Z",
    createdBy: "user_1",
    ...overrides,
  };
}
