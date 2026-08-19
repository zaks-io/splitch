import type { HashedAssignmentPutInput } from "./assignment-store";

/** Max put attempts after durable ownership (including the first). */
export const HOLDOVER_WRITE_MAX_ATTEMPTS = 8;

/** Base delay for exponential backoff between alarm retries. */
const HOLDOVER_WRITE_RETRY_BASE_MS = 1_000;

type HoldoverWriteJobStatus = "pending" | "completed" | "poisoned";

export interface HoldoverWriteJob extends HashedAssignmentPutInput {
  readonly status: HoldoverWriteJobStatus;
  readonly attempt: number;
  readonly updatedAtMs: number;
}

export interface HoldoverWriteEnsureResult {
  readonly status: "completed" | "owned" | "poisoned";
}

export interface HoldoverWriteOutboxStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface HoldoverWritePutPort {
  putHashed(input: HashedAssignmentPutInput): Promise<unknown>;
}

export interface HoldoverWriteOutboxLogger {
  error(message: string, detail: unknown): void;
}

export const HOLDOVER_WRITE_JOB_KEY = "holdover-write-job";

/**
 * One Durable Object per holdover intent: entity slot + Experiment.
 * Payload stays pseudonymous (hash only — no raw Targeting Key / ticket).
 */
export function holdoverWriteOutboxName(input: HashedAssignmentPutInput): string {
  return `${input.appId}\u001f${input.idType}\u001f${input.targetingKeyHash}\u001f${input.experimentId}`;
}

export function holdoverWriteRetryDelayMs(attempt: number): number {
  const capped = Math.max(0, Math.min(attempt, HOLDOVER_WRITE_MAX_ATTEMPTS));
  return HOLDOVER_WRITE_RETRY_BASE_MS * 2 ** Math.max(0, capped - 1);
}

export function scopedHoldoverWriteLog(
  job: Pick<
    HoldoverWriteJob,
    | "appId"
    | "experimentId"
    | "idType"
    | "targetingKeyHash"
    | "runId"
    | "variant"
    | "attempt"
    | "status"
  >,
): Record<string, unknown> {
  return {
    appId: job.appId,
    experimentId: job.experimentId,
    idType: job.idType,
    targetingKeyHash: job.targetingKeyHash,
    runId: job.runId,
    variant: job.variant,
    attempt: job.attempt,
    status: job.status,
  };
}

/**
 * Seal durable ownership, attempt `putHashed`, and schedule alarm retries on
 * failure. Idempotent under duplicate ensure / alarm delivery via putIfAbsent.
 */
export async function ensureHoldoverWriteJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  input: HashedAssignmentPutInput,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
): Promise<HoldoverWriteEnsureResult> {
  const existing = await storage.get<HoldoverWriteJob>(HOLDOVER_WRITE_JOB_KEY);
  if (existing?.status === "completed") {
    return { status: "completed" };
  }
  if (existing?.status === "poisoned") {
    return { status: "poisoned" };
  }

  const job: HoldoverWriteJob =
    existing ??
    ({
      ...input,
      status: "pending",
      attempt: 0,
      updatedAtMs: nowMs,
    } satisfies HoldoverWriteJob);

  if (existing === undefined) {
    await storage.put(HOLDOVER_WRITE_JOB_KEY, job);
  }

  return attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger);
}

export async function runHoldoverWriteAlarm(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
): Promise<void> {
  const job = await storage.get<HoldoverWriteJob>(HOLDOVER_WRITE_JOB_KEY);
  if (job === undefined || job.status !== "pending") return;
  await attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger);
}

async function attemptHoldoverWriteJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  job: HoldoverWriteJob,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
): Promise<HoldoverWriteEnsureResult> {
  if (job.status === "completed") return { status: "completed" };
  if (job.status === "poisoned") return { status: "poisoned" };

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
    const completed: HoldoverWriteJob = {
      ...job,
      status: "completed",
      attempt: nextAttempt,
      updatedAtMs: nowMs,
    };
    await storage.put(HOLDOVER_WRITE_JOB_KEY, completed);
    await storage.deleteAlarm();
    return { status: "completed" };
  } catch (cause) {
    if (nextAttempt >= HOLDOVER_WRITE_MAX_ATTEMPTS) {
      const poisoned: HoldoverWriteJob = {
        ...job,
        status: "poisoned",
        attempt: nextAttempt,
        updatedAtMs: nowMs,
      };
      await storage.put(HOLDOVER_WRITE_JOB_KEY, poisoned);
      await storage.deleteAlarm();
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
    await storage.put(HOLDOVER_WRITE_JOB_KEY, pending);
    await storage.setAlarm(nowMs + holdoverWriteRetryDelayMs(nextAttempt));
    logger?.error("holdover_write_put_failed_owned_for_retry", {
      ...scopedHoldoverWriteLog(pending),
      nextRetryDelayMs: holdoverWriteRetryDelayMs(nextAttempt),
      causeChain: errorMessages(cause),
    });
    return { status: "owned" };
  }
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
