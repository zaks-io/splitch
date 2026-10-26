import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "./env";
import { runControlPlaneScheduled } from "./scheduled";
import { delivery, NOW, resetDueWork } from "./scheduled-due-work-fixtures";
import { makePoolBindings } from "./test-bindings-pool";

let local: Awaited<ReturnType<typeof makePoolBindings>>;
let env: ControlPlaneApiEnv;
const event = { cron: "* * * * *", scheduledTime: Date.parse(NOW) } as ScheduledController;
const wake = vi.fn(async (_appId: string, _environmentId: string) => {});
const getByName = vi.fn((_name: string) => ({ wake }));

beforeEach(async () => {
  local = await makePoolBindings();
  await resetDueWork(local.d1);
  wake.mockReset().mockResolvedValue(undefined);
  getByName.mockClear();
  env = {
    INTEGRATION_DELIVERY_MODE: "coordinator",
    DB: local.d1,
    SESSION_STORE: local.kv,
    INTEGRATION_DELIVERY: { getByName },
  } as unknown as ControlPlaneApiEnv;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await local.dispose();
});

function observeLogs() {
  return {
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

async function tick() {
  const pending: Promise<unknown>[] = [];
  runControlPlaneScheduled(event, env, {
    waitUntil: (promise) => pending.push(promise),
  } as unknown as ExecutionContext);
  await Promise.all(pending);
}

async function seedDeliveryState(state: string) {
  for (const provider of ["convex", "cloudflare"] as const) {
    await delivery(
      local.d1,
      provider,
      state !== "future retry" && state !== "live lease",
      state === "expired lease" || state === "live lease",
    );
    if (state === "revoked")
      await local.d1.prepare(`UPDATE ${provider}_installations SET status = 'revoked'`).run();
  }
  if (state === "preparation backoff") {
    await local.d1
      .prepare("UPDATE convex_installations SET preparation_retry_at = '2026-10-22T08:01:00.000Z'")
      .run();
    await local.d1
      .prepare(
        "UPDATE cloudflare_config_deliveries SET next_attempt_at = '2026-10-22T08:01:00.000Z'",
      )
      .run();
  }
}

it.each([
  "pending",
  "expired lease",
  "future retry",
  "live lease",
  "revoked",
  "preparation backoff",
])("preserves sweep wakes for %s while batching both providers' lag", async (state) => {
  await seedDeliveryState(state);
  const logs = observeLogs();
  const originalPrepare = local.d1.prepare.bind(local.d1);
  const batch = vi.spyOn(local.d1, "batch");
  const prepare = vi.spyOn(local.d1, "prepare");
  const standalone = vi.fn();
  // Bind returns a new statement, so watch both bound and unbound execution methods.
  const observe = (statement: D1PreparedStatement) => {
    for (const method of ["all", "first", "run", "raw"] as const)
      vi.spyOn(statement, method).mockImplementation(standalone);
    return statement;
  };
  prepare.mockImplementation((query) => {
    const statement = observe(originalPrepare(query));
    const bind = statement.bind.bind(statement);
    vi.spyOn(statement, "bind").mockImplementation((...args) => observe(bind(...args)));
    return statement;
  });
  await tick();
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]?.[0]).toHaveLength(11);
  expect(prepare).toHaveBeenCalledTimes(12);
  expect(standalone).not.toHaveBeenCalled();
  const due = state === "pending" || state === "expired lease";
  expect(wake).toHaveBeenCalledTimes(due ? 1 : 0);
  if (due) {
    expect(getByName).toHaveBeenCalledExactlyOnceWith("app_probe:env_probe");
    expect(wake).toHaveBeenCalledExactlyOnceWith("app_probe", "env_probe");
  }
  const lagProviders =
    state === "revoked"
      ? []
      : state === "preparation backoff"
        ? ["cloudflare"]
        : ["convex", "cloudflare"];
  expect(logs.info.mock.calls.map(([row]) => row.provider)).toEqual(lagProviders);
  for (const provider of lagProviders)
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "integration_delivery_lagging", provider }),
    );
});

it.each(["rejection", "incomplete"])(
  "reports a %s probe and retries sweep and lag reads",
  async (failure) => {
    await delivery(local.d1, "convex", true);
    const logs = observeLogs();
    const batch = vi.spyOn(local.d1, "batch");
    if (failure === "rejection") batch.mockRejectedValueOnce(new Error("private_probe_canary"));
    else batch.mockResolvedValueOnce([]);
    await tick();
    expect(wake).toHaveBeenCalledExactlyOnceWith("app_probe", "env_probe");
    expect(logs.info).toHaveBeenCalledWith(
      expect.objectContaining({ message: "integration-delivery-lag", provider: "convex" }),
    );
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "scheduled_due_work_probe_failed",
        fault: expect.any(String),
      }),
    );
    expect(JSON.stringify(logs.error.mock.calls)).not.toContain("private_probe_canary");
  },
);

it("reports and rejects failed sweep wakes after a successful batch", async () => {
  await delivery(local.d1, "cloudflare", true);
  const logs = observeLogs();
  wake.mockRejectedValueOnce(new Error("private_wake_canary"));
  await expect(tick()).rejects.toThrow("integration_delivery_sweep_failed");
  expect(logs.error).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "integration_delivery_sweep_failed",
      fault: expect.any(String),
    }),
  );
  expect(JSON.stringify(logs.error.mock.calls)).not.toContain("private_wake_canary");
});
