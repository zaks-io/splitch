import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "./env";
import { runControlPlaneScheduled } from "./scheduled";
import { scheduledDueWork } from "./scheduled-due-work";
import {
  delivery,
  insertProbeRow,
  NOW,
  OLD,
  PROBE_CASES,
  resetDueWork,
  rotation,
  sentry,
} from "./scheduled-due-work-fixtures";
import { makePoolBindings } from "./test-bindings-pool";

let local: Awaited<ReturnType<typeof makePoolBindings>>;
let env: ControlPlaneApiEnv;
const event = { cron: "* * * * *", scheduledTime: Date.parse(NOW) } as ScheduledController;
const idle = {
  privacyReconciliation: false,
  privacyArtifactPurge: false,
  personalAccessTokenRetention: false,
  temporaryEnvironmentTeardown: false,
  auditEventForwarding: false,
  convexWebhookDispatch: false,
  cloudflarePushDispatch: false,
  sentryWebhookDispatch: false,
};
beforeEach(async () => {
  local = await makePoolBindings();
  await resetDueWork(local.d1);
  env = {
    INTEGRATION_DELIVERY_MODE: "cron",
    DB: local.d1,
    SESSION_STORE: local.kv,
  } as ControlPlaneApiEnv;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await local.dispose();
});
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

it.each(PROBE_CASES)("flags only $name when due", async ({ job, seed }) => {
  await seed(local.d1, true);
  expect(await scheduledDueWork(env, event, ctx)).toEqual({ ...idle, [job]: true });
});
it.each(PROBE_CASES)("does not flag $name before it is due", async ({ seed }) => {
  await seed(local.d1, false);
  expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
});
it("runs only the due probe and two lag reads on an idle minute tick", async () => {
  const batch = vi.spyOn(local.d1, "batch");
  const prepare = vi.spyOn(local.d1, "prepare");
  const pending: Promise<unknown>[] = [];
  runControlPlaneScheduled(event, env, {
    waitUntil: (promise) => pending.push(promise),
  } as unknown as ExecutionContext);
  await Promise.all(pending);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledTimes(12);
  expect(batch.mock.calls[0]?.[0]).toHaveLength(10);
});
it("keeps referenced step-up uses until their rotation can be removed", async () => {
  await insertProbeRow(local.d1, "personal_access_token_step_up_uses", {
    jti: "use_probe",
    user_id: "user_probe",
    consumed_at: OLD,
    expires_at: OLD,
  });
  await rotation(local.d1, "claimed", NOW, "use_probe");
  expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
});
it("honors Convex preparation backoff", async () => {
  await delivery(local.d1, "convex", true);
  await local.d1
    .prepare("UPDATE convex_installations SET preparation_retry_at = '2026-10-22T08:01:00.000Z'")
    .run();
  expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
});
it.each(["convex", "cloudflare"] as const)("ignores revoked %s installations", async (provider) => {
  await delivery(local.d1, provider, true);
  await local.d1.prepare(`UPDATE ${provider}_installations SET status = 'revoked'`).run();
  expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
});
it.each(["convex", "cloudflare"] as const)(
  "does not dispatch an older %s version ahead of the newest retry",
  async (provider) => {
    await delivery(local.d1, provider, true);
    const table =
      provider === "convex" ? "config_webhook_deliveries" : "cloudflare_config_deliveries";
    await insertProbeRow(local.d1, table, {
      delivery_id: "newest",
      installation_id: "installation_probe",
      app_id: "app_probe",
      environment_id: "env_probe",
      environment_version: 2,
      state: "pending",
      next_attempt_at: "2026-10-22T08:01:00.000Z",
      created_at: OLD,
      ...(provider === "convex" ? { body_json: "{}" } : {}),
    });
    expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
  },
);
it.each(["temporary", "consumed", "revoked", "foreign"])(
  "ignores Sentry %s events or installations",
  async (kind) => {
    await sentry(local.d1, true);
    if (kind === "temporary")
      await local.d1.prepare("UPDATE flag_change_events SET temporary_environment = 1").run();
    if (kind === "consumed")
      await local.d1
        .prepare(
          "UPDATE sentry_installations SET last_delivered_seq = (SELECT MAX(seq) FROM flag_change_events)",
        )
        .run();
    if (kind === "revoked")
      await local.d1.prepare("UPDATE sentry_installations SET status = 'revoked'").run();
    if (kind === "foreign")
      await local.d1.prepare("UPDATE flag_change_events SET app_id = 'foreign_app'").run();
    expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
  },
);

it("keeps Convex work behind any unexpired installation lease", async () => {
  await delivery(local.d1, "convex", true);
  await insertProbeRow(local.d1, "config_webhook_deliveries", {
    delivery_id: "busy",
    installation_id: "installation_probe",
    app_id: "app_probe",
    environment_id: "env_probe",
    environment_version: 0,
    state: "leased",
    body_json: "{}",
    next_attempt_at: OLD,
    lease_owner: "other",
    lease_expires_at: "2026-10-22T08:01:00.000Z",
    created_at: OLD,
  });
  expect(await scheduledDueWork(env, event, ctx)).toEqual(idle);
});
async function tick() {
  const pending: Promise<unknown>[] = [];
  runControlPlaneScheduled(event, env, {
    waitUntil: (promise) => pending.push(promise),
  } as unknown as ExecutionContext);
  await Promise.all(pending);
}
it("enqueues privacy reconciliation through a real minute tick", async () => {
  const privacy = PROBE_CASES.find((row) => row.name === "privacy queued");
  if (!privacy) throw new Error("missing privacy fixture");
  await privacy.seed(local.d1, true);
  const send = vi.fn(async () => {});
  env.PRIVACY_JOBS_QUEUE = { send } as unknown as ControlPlaneApiEnv["PRIVACY_JOBS_QUEUE"];
  await tick();
  expect(send).toHaveBeenCalledExactlyOnceWith({ requestId: "request_probe" });
});
it("purges an expired privacy artifact through a real minute tick", async () => {
  const artifact = PROBE_CASES.find((row) => row.name === "privacy artifact");
  if (!artifact) throw new Error("missing artifact fixture");
  await artifact.seed(local.d1, true);
  const remove = vi.fn(async () => {});
  env.PRIVACY_EXPORTS = { delete: remove } as unknown as R2Bucket;
  await tick();
  expect(remove).toHaveBeenCalledExactlyOnceWith("artifact");
  expect(
    await local.d1.prepare("SELECT artifact_key FROM privacy_jobs").first("artifact_key"),
  ).toBeNull();
});
it("cleans terminal PAT rotations through a real minute tick", async () => {
  await rotation(local.d1, "completed", OLD);
  await tick();
  expect(
    await local.d1.prepare("SELECT 1 FROM personal_access_token_rotations").first(),
  ).toBeNull();
});

it.each(["convex", "cloudflare"] as const)(
  "reports real D1 %s lag while an unexpired lease keeps dispatch idle",
  async (provider) => {
    await delivery(local.d1, provider, false, true);
    const table =
      provider === "convex" ? "config_webhook_deliveries" : "cloudflare_config_deliveries";
    await local.d1.prepare(`UPDATE ${table} SET created_at = '2026-10-22T07:54:00.000Z'`).run();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const faults = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Promise<unknown>[] = [];
    runControlPlaneScheduled(event, env, {
      waitUntil: (promise) => pending.push(promise),
    } as unknown as ExecutionContext);
    await Promise.all(pending);
    const fields = {
      provider,
      appId: "app_probe",
      environmentId: "env_probe",
      oldestAgeMs: 360_000,
      healthyInstallationsWaiting: 1,
    };
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "integration-delivery-lag", ...fields }),
    );
    expect(faults).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "integration_delivery_lagging", ...fields }),
    );
  },
);
