import type { HashedAssignmentPutInput } from "./assignment-store";
import type { HoldoverWriteAppInventoryRegisterResult } from "./holdover-write-app-inventory";
import {
  HOLDOVER_WRITE_JOB_PREFIX,
  HOLDOVER_WRITE_MAX_ATTEMPTS,
  type HoldoverWriteEnsureResult,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxLogger,
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  type HoldoverWriteSuppressionPort,
  holdoverWriteJobDueAtMs,
  holdoverWriteJobKey,
  holdoverWriteRetryDelayMs,
  purgeStaleJobs,
  readEntitySuppression,
  reschedulePendingHoldoverWriteAlarm,
  scopedHoldoverWriteLog,
} from "./holdover-write-outbox-core";

export interface HoldoverWriteEnsureOptions {
  /** Exposure / ticket created-at; defaults to nowMs for first ownership. */
  readonly sourceCreatedAtMs?: number;
}

const APP_SUPPRESSION_RECHECK_MS = 60_000;

/** Registers this Entity in the App inventory before ownership is acknowledged. */
export interface HoldoverWriteInventoryRegisterPort {
  registerEntity(ref: {
    readonly idType: string;
    readonly targetingKeyHash: string;
  }): Promise<HoldoverWriteAppInventoryRegisterResult>;
}

/**
 * Seal durable ownership, attempt `putHashed` (KV-complete), and schedule alarm
 * retries on failure. Idempotent under duplicate ensure / alarm delivery.
 */
export async function ensureHoldoverWriteJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  input: HashedAssignmentPutInput,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
  suppression?: HoldoverWriteSuppressionPort,
  options?: HoldoverWriteEnsureOptions,
  inventory?: HoldoverWriteInventoryRegisterPort,
): Promise<HoldoverWriteEnsureResult> {
  const sourceCreatedAtMs = options?.sourceCreatedAtMs ?? nowMs;
  // App freeze/suppress must not destroy recoverable durable jobs — only block puts.
  if (suppression && (await suppression.isAppSuppressed(input.appId))) {
    return { status: "suppressed" };
  }
  if (await isStaleUnderEntityCutoff(storage, sourceCreatedAtMs)) {
    await purgeStaleJobs(storage, sourceCreatedAtMs);
    return { status: "suppressed" };
  }

  // Confirm App inventory registration on every ensure until acknowledged.
  // Register before sealing a new local job so a transport failure cannot leave
  // a durable unindexed Entity outbox; retries re-register until confirmed.
  if (inventory) {
    const registration = await inventory.registerEntity({
      idType: input.idType,
      targetingKeyHash: input.targetingKeyHash,
    });
    if (registration.status === "suppressed") {
      return { status: "suppressed" };
    }
  }

  const jobKey = holdoverWriteJobKey(input.experimentId);
  const existing = await storage.get<HoldoverWriteJob>(jobKey);
  const deferred = await resultForDeferredExistingJob(storage, existing, nowMs);
  if (deferred !== undefined) return deferred;

  const job: HoldoverWriteJob =
    existing ??
    ({
      ...input,
      status: "pending",
      attempt: 0,
      createdAtMs: sourceCreatedAtMs,
      updatedAtMs: nowMs,
    } satisfies HoldoverWriteJob);

  if (existing === undefined) {
    await storage.put(jobKey, job);
  }

  return attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger, suppression);
}

async function resultForDeferredExistingJob(
  storage: HoldoverWriteOutboxStorage,
  existing: HoldoverWriteJob | undefined,
  nowMs: number,
): Promise<HoldoverWriteEnsureResult | undefined> {
  if (existing?.status === "poisoned") return { status: "poisoned" };
  if (existing === undefined || holdoverWriteJobDueAtMs(existing) <= nowMs) return undefined;
  await reschedulePendingHoldoverWriteAlarm(storage);
  return { status: "owned" };
}

export async function runHoldoverWriteAlarm(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<void> {
  const jobs = await listJobs(storage);
  if (jobs.length === 0) return;

  const appId = jobs[0]?.appId;
  if (appId !== undefined && (await suppression?.isAppSuppressed(appId))) {
    // KV deletes are eventually consistent. Keep accepted work durably
    // recheckable until every location observes App cancellation.
    await storage.setAlarm(nowMs + APP_SUPPRESSION_RECHECK_MS);
    return;
  }

  const cutoff = await readEntitySuppression(storage);
  for (const job of jobs) {
    await retryDueAlarmJob(storage, putPort, job, nowMs, cutoff, logger, suppression);
  }
  await reschedulePendingHoldoverWriteAlarm(storage);
}

async function retryDueAlarmJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  job: HoldoverWriteJob,
  nowMs: number,
  cutoff: Awaited<ReturnType<typeof readEntitySuppression>>,
  logger?: HoldoverWriteOutboxLogger,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<void> {
  if (job.status !== "pending") return;
  if (cutoff !== undefined && job.createdAtMs <= cutoff.deleteBeforeTsMs) {
    await storage.delete(holdoverWriteJobKey(job.experimentId));
    return;
  }
  if (holdoverWriteJobDueAtMs(job) > nowMs) return;
  await attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger, suppression);
}

/** Re-arm alarms for pending jobs after App deletion cancel/restore. */
export async function resumeHoldoverWriteAlarms(
  storage: HoldoverWriteOutboxStorage,
): Promise<void> {
  await reschedulePendingHoldoverWriteAlarm(storage);
}

async function attemptHoldoverWriteJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  job: HoldoverWriteJob,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<HoldoverWriteEnsureResult> {
  if (suppression && (await suppression.isAppSuppressed(job.appId))) {
    await storage.setAlarm(nowMs + APP_SUPPRESSION_RECHECK_MS);
    return { status: "suppressed" };
  }
  if (await isStaleUnderEntityCutoff(storage, job.createdAtMs)) {
    await storage.delete(holdoverWriteJobKey(job.experimentId));
    await reschedulePendingHoldoverWriteAlarm(storage);
    return { status: "suppressed" };
  }
  if (job.status === "poisoned") return { status: "poisoned" };

  const jobKey = holdoverWriteJobKey(job.experimentId);
  const nextAttempt = job.attempt + 1;
  try {
    await putPort.putHashed({
      appId: job.appId,
      experimentId: job.experimentId,
      idType: job.idType,
      targetingKeyHash: job.targetingKeyHash,
      runId: job.runId,
      variant: job.variant,
    });
    await storage.delete(jobKey);
    await reschedulePendingHoldoverWriteAlarm(storage);
    return { status: "completed" };
  } catch (cause) {
    if (nextAttempt >= HOLDOVER_WRITE_MAX_ATTEMPTS) {
      const poisoned: HoldoverWriteJob = {
        ...job,
        status: "poisoned",
        attempt: nextAttempt,
        updatedAtMs: nowMs,
      };
      await storage.put(jobKey, poisoned);
      await reschedulePendingHoldoverWriteAlarm(storage);
      logger?.error("holdover_write_retry_exhausted", {
        ...scopedHoldoverWriteLog(poisoned),
        causeChain: errorMessages(cause),
      });
      return { status: "poisoned" };
    }

    const pending: HoldoverWriteJob = {
      ...job,
      status: "pending",
      attempt: nextAttempt,
      updatedAtMs: nowMs,
    };
    await storage.put(jobKey, pending);
    await reschedulePendingHoldoverWriteAlarm(storage);
    logger?.error("holdover_write_put_failed_owned_for_retry", {
      ...scopedHoldoverWriteLog(pending),
      nextRetryDelayMs: holdoverWriteRetryDelayMs(nextAttempt),
      causeChain: errorMessages(cause),
    });
    return { status: "owned" };
  }
}

async function isStaleUnderEntityCutoff(
  storage: HoldoverWriteOutboxStorage,
  sourceCreatedAtMs: number,
): Promise<boolean> {
  const entity = await readEntitySuppression(storage);
  if (entity === undefined) return false;
  return sourceCreatedAtMs <= entity.deleteBeforeTsMs;
}

async function listJobs(storage: HoldoverWriteOutboxStorage): Promise<HoldoverWriteJob[]> {
  const listed = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  return [...listed.values()];
}

function errorMessages(cause: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = cause;
  const seen = new Set<Error>();
  while (current instanceof Error) {
    if (seen.has(current)) {
      chain.push("[circular Error cause]");
      break;
    }
    seen.add(current);
    chain.push(current.message);
    current = current.cause;
  }
  if (!(cause instanceof Error) && cause !== undefined) chain.push(String(cause));
  return chain;
}
