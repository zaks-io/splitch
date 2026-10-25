import type { EnvScope, Repository } from "@splitch/db";
import type { CloudflareDispatchSummary } from "./cloudflare-push-dispatch";
import type { ConvexDispatchSummary } from "./convex-webhook-dispatch";
import { DELIVERY_RUN_SUBREQUEST_BUDGET } from "./integration-delivery-limits";

export function integrationDeliverySummary() {
  return {
    convex: {
      claimed: 0,
      received2xx: 0,
      receiverRejected: 0,
      transportFailures: 0,
      preparationFailedInstallations: 0,
      skippedLeaseLost: 0,
    } satisfies ConvexDispatchSummary,
    cloudflare: {
      claimed: 0,
      received2xx: 0,
      receiverRejected: 0,
      transportFailures: 0,
      preparationFailures: 0,
      skippedLeaseLost: 0,
    } satisfies CloudflareDispatchSummary,
  };
}

interface IntegrationDeliveryRunDeps {
  repo: Pick<Repository, "integrationDeliverySchedule">;
  scope: EnvScope;
  subrequests: { readonly count: number };
  dispatchConvex: (
    scope: EnvScope,
    onDispatch: (summary: ConvexDispatchSummary) => void,
  ) => Promise<number>;
  dispatchCloudflare: (
    scope: EnvScope,
    onDispatch: (summary: CloudflareDispatchSummary) => void,
  ) => Promise<number>;
  now: () => Date;
  summary?: ReturnType<typeof integrationDeliverySummary>;
}

export async function runIntegrationDelivery(deps: IntegrationDeliveryRunDeps) {
  const startedAt = deps.now().getTime();
  const summary = deps.summary ?? integrationDeliverySummary();
  const { scope } = deps;
  const canClaim = () =>
    deps.now().getTime() - startedAt < 60_000 &&
    deps.subrequests.count < DELIVERY_RUN_SUBREQUEST_BUDGET;
  while (canClaim()) {
    const convex = await deps.dispatchConvex(scope, (pass) => addCounts(summary.convex, pass));
    if (!canClaim()) break;
    const cloudflare = await deps.dispatchCloudflare(scope, (pass) =>
      addCounts(summary.cloudflare, pass),
    );
    if (convex + cloudflare === 0) break;
  }
  const now = deps.now().toISOString();
  const nextWakeAt =
    deps.subrequests.count >= DELIVERY_RUN_SUBREQUEST_BUDGET
      ? now
      : await readNextWakeAt(deps, now);
  return {
    summary,
    durationMs: deps.now().getTime() - startedAt,
    nextWakeAt,
    subrequests: deps.subrequests.count,
  };
}

async function readNextWakeAt(deps: IntegrationDeliveryRunDeps, now: string) {
  const { scope } = deps;
  const due = await deps.repo.integrationDeliverySchedule.environmentsWithDueDeliveries({
    now,
    scope,
  });
  return due.length > 0
    ? now
    : deps.repo.integrationDeliverySchedule.nextDeliveryWakeAt(scope, now);
}

function addCounts<T extends object>(total: T, pass: T) {
  for (const key of Object.keys(total) as (keyof T)[]) {
    (total[key] as number) += pass[key] as number;
  }
}
