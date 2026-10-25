import type { EnvScope, Repository } from "@splitch/db";
import type { CloudflareDispatchSummary } from "./cloudflare-push-dispatch";
import type { ConvexDispatchSummary } from "./convex-webhook-dispatch";
import { DELIVERY_BATCH_SIZE, DELIVERY_RUN_CLAIM_BUDGET } from "./integration-delivery-limits";

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
  dispatchConvex: (
    scope: EnvScope,
    onDispatch: (summary: ConvexDispatchSummary) => void,
    claimLimit: number,
  ) => Promise<number>;
  dispatchCloudflare: (
    scope: EnvScope,
    onDispatch: (summary: CloudflareDispatchSummary) => void,
    claimLimit: number,
  ) => Promise<number>;
  now: () => Date;
  summary?: ReturnType<typeof integrationDeliverySummary>;
}

export async function runIntegrationDelivery(deps: IntegrationDeliveryRunDeps) {
  const startedAt = deps.now().getTime();
  const summary = deps.summary ?? integrationDeliverySummary();
  const { scope } = deps;
  let claimed = 0;
  const claimLimit = () => Math.min(DELIVERY_BATCH_SIZE, DELIVERY_RUN_CLAIM_BUDGET - claimed);
  while (deps.now().getTime() - startedAt < 60_000 && claimed < DELIVERY_RUN_CLAIM_BUDGET) {
    const convex = await deps.dispatchConvex(
      scope,
      (pass) => addCounts(summary.convex, pass),
      claimLimit(),
    );
    claimed += convex;
    if (claimed >= DELIVERY_RUN_CLAIM_BUDGET) break;
    const cloudflare = await deps.dispatchCloudflare(
      scope,
      (pass) => addCounts(summary.cloudflare, pass),
      claimLimit(),
    );
    claimed += cloudflare;
    if (convex + cloudflare === 0) break;
  }
  const now = deps.now().toISOString();
  const nextWakeAt = claimed >= DELIVERY_RUN_CLAIM_BUDGET ? now : await readNextWakeAt(deps, now);
  return { summary, durationMs: deps.now().getTime() - startedAt, nextWakeAt };
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
