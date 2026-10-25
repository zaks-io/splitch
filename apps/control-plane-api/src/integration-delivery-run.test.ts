import { envScope } from "@splitch/db";
import { expect, it, vi } from "vitest";
import { integrationDeliveryMode } from "./control-plane-runtime-config";
import {
  DELIVERY_BATCH_SIZE,
  DELIVERY_COMPLETION_BUDGET_MS,
  DELIVERY_LEASE_MS,
  DELIVERY_PREPARATION_BUDGET_MS,
  DELIVERY_RUN_SUBREQUEST_BUDGET,
  DELIVERY_SEND_CONCURRENCY,
  DELIVERY_SEND_TIMEOUT_MS,
} from "./integration-delivery-limits";
import { runIntegrationDelivery } from "./integration-delivery-run";

const scope = envScope("app", "env");
const now = new Date("2026-10-25T00:00:00.000Z");

it("finishes its batch and yields once counted subrequests reach the budget", async () => {
  const subrequests = { count: DELIVERY_RUN_SUBREQUEST_BUDGET - 1 };
  let completed = false;
  const dispatchConvex = vi.fn(async () => {
    subrequests.count += 20;
    await Promise.resolve();
    completed = true;
    return 6;
  });
  const dispatchCloudflare = vi.fn(async () => 6);
  const schedule = {
    environmentsWithDueDeliveries: vi.fn(),
    nextDeliveryWakeAt: vi.fn(),
  };
  const result = await runIntegrationDelivery({
    scope,
    subrequests,
    now: () => now,
    repo: { integrationDeliverySchedule: schedule },
    dispatchConvex,
    dispatchCloudflare,
  });
  expect(completed).toBe(true);
  expect(dispatchConvex).toHaveBeenCalledTimes(1);
  expect(dispatchCloudflare).not.toHaveBeenCalled();
  expect(schedule.environmentsWithDueDeliveries).not.toHaveBeenCalled();
  expect(result.nextWakeAt).toBe(now.toISOString());
  expect(result.subrequests).toBe(5_019);
});

it("claims sequentially, drains passes, and returns the next retry", async () => {
  const order: string[] = [];
  const dispatchConvex = vi
    .fn(async () => {
      order.push("convex");
      return 0;
    })
    .mockImplementationOnce(async () => {
      order.push("convex");
      return 25;
    });
  const dispatchCloudflare = vi.fn(async () => {
    order.push("cloudflare");
    return 0;
  });
  const schedule = {
    environmentsWithDueDeliveries: vi.fn(async () => []),
    nextDeliveryWakeAt: vi.fn(async () => "2026-10-25T00:00:01.000Z"),
  };
  const result = await runIntegrationDelivery({
    scope,
    repo: { integrationDeliverySchedule: schedule },
    subrequests: { count: 0 },
    dispatchConvex,
    dispatchCloudflare,
    now: () => now,
  });
  expect(order).toEqual(["convex", "cloudflare", "convex", "cloudflare"]);
  expect(result.nextWakeAt).toBe("2026-10-25T00:00:01.000Z");
  expect(schedule.nextDeliveryWakeAt).toHaveBeenCalledWith(scope, now.toISOString());
});

it("yields to an immediate alarm when the run budget is spent and work remains", async () => {
  let time = now.getTime();
  const result = await runIntegrationDelivery({
    scope,
    now: () => new Date(time),
    subrequests: { count: 0 },
    repo: {
      integrationDeliverySchedule: {
        environmentsWithDueDeliveries: async () => [{ appId: "app", environmentId: "env" }],
        nextDeliveryWakeAt: async () => {
          throw new Error("Due work cannot wait for a future retry");
        },
      },
    },
    dispatchConvex: async () => {
      time += 30_000;
      return 25;
    },
    dispatchCloudflare: async () => {
      time += 30_000;
      return 25;
    },
  });
  expect(result.durationMs).toBe(60_000);
  expect(result.nextWakeAt).toBe("2026-10-25T00:01:00.000Z");
});

it("keeps a whole batch of timed sends inside its lease", () => {
  expect(DELIVERY_BATCH_SIZE).toBeLessThanOrEqual(DELIVERY_SEND_CONCURRENCY);
  expect(
    DELIVERY_PREPARATION_BUDGET_MS + DELIVERY_SEND_TIMEOUT_MS + DELIVERY_COMPLETION_BUDGET_MS,
  ).toBeLessThan(DELIVERY_LEASE_MS);
});

it.each([undefined, "", "invalid"])("fails loudly for invalid mode %s", (mode) => {
  expect(() => integrationDeliveryMode({ INTEGRATION_DELIVERY_MODE: mode } as never)).toThrow(
    "INTEGRATION_DELIVERY_MODE",
  );
});
