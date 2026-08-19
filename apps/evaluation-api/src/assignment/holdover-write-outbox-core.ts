import { assignmentWriterName, type HashedAssignmentPutInput } from "./assignment-store";

/** Max put attempts after durable ownership (including the first). */
export const HOLDOVER_WRITE_MAX_ATTEMPTS = 8;

/** Base delay for exponential backoff between alarm retries. */
const HOLDOVER_WRITE_RETRY_BASE_MS = 1_000;

type HoldoverWriteJobStatus = "pending" | "poisoned";

export interface HoldoverWriteJob extends HashedAssignmentPutInput {
  readonly status: HoldoverWriteJobStatus;
  readonly attempt: number;
  readonly updatedAtMs: number;
}

export interface HoldoverWriteEnsureResult {
  readonly status: "completed" | "owned" | "poisoned" | "suppressed";
}

export interface HoldoverWriteOutboxStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | undefined>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface HoldoverWritePutPort {
  putHashed(input: HashedAssignmentPutInput): Promise<unknown>;
}

export interface HoldoverWriteSuppressionPort {
  /** App-wide deletion tombstone — checked before every put/alarm attempt. */
  isAppSuppressed(appId: string): Promise<boolean>;
}

export interface HoldoverWriteOutboxLogger {
  error(message: string, detail: unknown): void;
}

export const HOLDOVER_WRITE_JOB_PREFIX = "holdover-write-job:";
export const HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY = "holdover-write-suppressed";

/**
 * One Durable Object per Entity slot (same naming as the Assignment writer).
 * Jobs are stored per Experiment so Entity deletion can purge the whole DO.
 */
export function holdoverWriteOutboxName(
  input: Pick<HashedAssignmentPutInput, "appId" | "idType" | "targetingKeyHash">,
): string {
  return assignmentWriterName(input);
}

export function holdoverWriteJobKey(experimentId: string): string {
  return `${HOLDOVER_WRITE_JOB_PREFIX}${experimentId}`;
}

export function holdoverWriteRetryDelayMs(attempt: number): number {
  const capped = Math.max(0, Math.min(attempt, HOLDOVER_WRITE_MAX_ATTEMPTS));
  return HOLDOVER_WRITE_RETRY_BASE_MS * 2 ** Math.max(0, capped - 1);
}

export function appHoldoverWriteSuppressKey(appId: string): string {
  return `holdover-write-suppress:app:${appId}`;
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
): Promise<HoldoverWriteEnsureResult> {
  if (await isSuppressed(storage, input.appId, suppression)) {
    await purgeEntityOutboxState(storage);
    return { status: "suppressed" };
  }

  const jobKey = holdoverWriteJobKey(input.experimentId);
  const existing = await storage.get<HoldoverWriteJob>(jobKey);
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
    await storage.put(jobKey, job);
  }

  return attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger, suppression);
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
  if (appId !== undefined && (await isSuppressed(storage, appId, suppression))) {
    await purgeEntityOutboxState(storage);
    return;
  }

  for (const job of jobs) {
    if (job.status !== "pending") continue;
    await attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger, suppression);
  }
}

/** Mark the Entity outbox suppressed and cancel pending alarms (no further puts). */
export async function suppressEntityOutbox(storage: HoldoverWriteOutboxStorage): Promise<void> {
  await storage.put(HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY, true);
  await storage.deleteAlarm();
}

/**
 * Purge pending / poisoned job rows (hashes) and cancel alarms. Keeps the Entity
 * suppress tombstone so a post-deletion retry cannot recreate Assignment Store
 * state after physical purge of durable job payloads.
 */
export async function purgeEntityOutboxState(storage: HoldoverWriteOutboxStorage): Promise<void> {
  const jobs = await storage.list({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  for (const key of jobs.keys()) {
    await storage.delete(key);
  }
  await storage.deleteAlarm();
}

async function attemptHoldoverWriteJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  job: HoldoverWriteJob,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<HoldoverWriteEnsureResult> {
  if (await isSuppressed(storage, job.appId, suppression)) {
    await purgeEntityOutboxState(storage);
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
    // Success: drop the job so completed state does not retain hashes.
    await storage.delete(jobKey);
    await rescheduleOrClearAlarm(storage, nowMs);
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
      await rescheduleOrClearAlarm(storage, nowMs);
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
    await storage.setAlarm(nowMs + holdoverWriteRetryDelayMs(nextAttempt));
    logger?.error("holdover_write_put_failed_owned_for_retry", {
      ...scopedHoldoverWriteLog(pending),
      nextRetryDelayMs: holdoverWriteRetryDelayMs(nextAttempt),
      causeChain: errorMessages(cause),
    });
    return { status: "owned" };
  }
}

async function isSuppressed(
  storage: HoldoverWriteOutboxStorage,
  appId: string,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<boolean> {
  if ((await storage.get<boolean>(HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY)) === true) {
    return true;
  }
  if (suppression && (await suppression.isAppSuppressed(appId))) {
    return true;
  }
  return false;
}

async function listJobs(storage: HoldoverWriteOutboxStorage): Promise<HoldoverWriteJob[]> {
  const listed = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  return [...listed.values()];
}

async function rescheduleOrClearAlarm(
  storage: HoldoverWriteOutboxStorage,
  nowMs: number,
): Promise<void> {
  const pending = (await listJobs(storage)).filter((job) => job.status === "pending");
  if (pending.length === 0) {
    await storage.deleteAlarm();
    return;
  }
  const nextAttempt = Math.min(...pending.map((job) => Math.max(1, job.attempt)));
  await storage.setAlarm(nowMs + holdoverWriteRetryDelayMs(nextAttempt));
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
