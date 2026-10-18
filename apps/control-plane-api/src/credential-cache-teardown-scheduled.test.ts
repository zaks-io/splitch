import { beforeEach, expect, it, vi } from "vitest";
import type { ControlPlaneApiEnv } from "./env";
import { runTemporaryEnvironmentTeardown } from "./temporary-environment-teardown-scheduled";

const jobs = vi.hoisted(() => ({ scan: vi.fn(), teardown: vi.fn() }));
vi.mock("@splitch/db", async (original) => ({
  ...(await original<typeof import("@splitch/db")>()),
  createRepository: () => ({
    identity: {
      listExpiredTemporaryEnvironments: jobs.scan,
      getApp: async () => ({ organizationId: "org_teardown" }),
    },
  }),
}));
vi.mock("./temporary-environment-teardown", () => ({
  teardownTemporaryEnvironment: jobs.teardown,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  jobs.scan.mockReset().mockResolvedValue([{ id: "env_temporary", appId: "app_teardown" }]);
  jobs.teardown.mockReset().mockResolvedValue(undefined);
});

const event = {
  cron: "* * * * *",
  scheduledTime: Date.parse("2026-10-17T00:00:00.000Z"),
} as ScheduledController;
const ctx = { waitUntil: (_promise: Promise<unknown>) => {} };

it("emits scrubbed teardown completion counts and its Environment id", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  await runTemporaryEnvironmentTeardown({} as ControlPlaneApiEnv, event, ctx);
  expect(jobs.scan).toHaveBeenCalledWith("2026-10-17T00:00:00.000Z", 5);
  expect(info).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "temporary-environment-teardown",
      environmentId: "env_temporary",
      deleted: 1,
    }),
  );
});

it.each(["scan", "teardown"] as const)(
  "reports and rethrows an opaque fault when %s fails",
  async (job) => {
    const canary = "private-teardown-canary";
    jobs[job].mockRejectedValue(new Error(canary));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runTemporaryEnvironmentTeardown({} as ControlPlaneApiEnv, event, ctx),
    ).rejects.toThrow(/^temporary_environment_teardown_failed$/);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ message: "temporary_environment_teardown_failed" }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain(canary);
  },
);
