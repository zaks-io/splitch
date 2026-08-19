import { assignmentWriterName, type HashedAssignmentPutInput } from "./assignment-store";

/** Max put attempts after durable ownership (including the first). */
export const HOLDOVER_WRITE_MAX_ATTEMPTS = 8;

/** Base delay for exponential backoff between alarm retries. */
const HOLDOVER_WRITE_RETRY_BASE_MS = 1_000;

type HoldoverWriteJobStatus = "pending" | "poisoned";

export interface HoldoverWriteJob extends HashedAssignmentPutInput {
  readonly status: HoldoverWriteJobStatus;
  readonly attempt: number;
  /** First ownership / ensure time — compared to Entity delete_before_ts. */
  readonly createdAtMs: number;
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

/** Cutoff tombstone: stale work ≤ deleteBeforeTsMs is suppressed; newer work may proceed. */
interface EntityHoldoverWriteSuppression {
  readonly deleteBeforeTsMs: number;
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

export interface HoldoverWriteEnsureOptions {
  /** Exposure / source created-at; defaults to nowMs for first ownership. */
  readonly sourceCreatedAtMs?: number;
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
): Promise<HoldoverWriteEnsureResult> {
  const sourceCreatedAtMs = options?.sourceCreatedAtMs ?? nowMs;
  if (await isStaleUnderSuppression(storage, input.appId, sourceCreatedAtMs, suppression)) {
    await purgeStaleJobs(storage, sourceCreatedAtMs);
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
      createdAtMs: sourceCreatedAtMs,
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
  if (appId !== undefined && (await suppression?.isAppSuppressed(appId))) {
    await purgeEntityOutboxState(storage);
    return;
  }

  const cutoff = await entitySuppression(storage);
  for (const job of jobs) {
    if (job.status !== "pending") continue;
    if (cutoff !== undefined && job.createdAtMs <= cutoff.deleteBeforeTsMs) {
      await storage.delete(holdoverWriteJobKey(job.experimentId));
      continue;
    }
    await attemptHoldoverWriteJob(storage, putPort, job, nowMs, logger, suppression);
  }
  await rescheduleOrClearAlarm(storage, nowMs);
}

/**
 * Entity deletion handshake step 1: record cutoff and cancel alarms for stale
 * work. Must run under DO `blockConcurrencyWhile` so it cannot interleave with
 * an in-flight put — the caller waits until the current ensure/alarm finishes.
 */
export async function suppressEntityOutbox(
  storage: HoldoverWriteOutboxStorage,
  deleteBeforeTsMs: number,
): Promise<void> {
  if (!Number.isFinite(deleteBeforeTsMs)) {
    throw new Error("suppressEntityOutbox: deleteBeforeTsMs must be finite");
  }
  await storage.put(HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY, {
    deleteBeforeTsMs,
  } satisfies EntityHoldoverWriteSuppression);
  await storage.deleteAlarm();
}

/**
 * Purge pending / poisoned job rows at or before the Entity cutoff (hashes) and
 * cancel alarms. Keeps the Entity suppress tombstone so a stale post-deletion
 * retry cannot recreate Assignment Store state.
 */
export async function purgeEntityOutboxState(
  storage: HoldoverWriteOutboxStorage,
  deleteBeforeTsMs: number = Number.POSITIVE_INFINITY,
): Promise<void> {
  await purgeStaleJobs(storage, deleteBeforeTsMs);
  await storage.deleteAlarm();
}

/** Full Entity deletion handshake: suppress → purge stale under one critical section. */
export async function deleteEntityOutbox(
  storage: HoldoverWriteOutboxStorage,
  deleteBeforeTsMs: number,
): Promise<void> {
  await suppressEntityOutbox(storage, deleteBeforeTsMs);
  await purgeEntityOutboxState(storage, deleteBeforeTsMs);
}

async function attemptHoldoverWriteJob(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  job: HoldoverWriteJob,
  nowMs: number,
  logger?: HoldoverWriteOutboxLogger,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<HoldoverWriteEnsureResult> {
  if (await isStaleUnderSuppression(storage, job.appId, job.createdAtMs, suppression)) {
    await storage.delete(holdoverWriteJobKey(job.experimentId));
    await rescheduleOrClearAlarm(storage, nowMs);
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

async function isStaleUnderSuppression(
  storage: HoldoverWriteOutboxStorage,
  appId: string,
  sourceCreatedAtMs: number,
  suppression?: HoldoverWriteSuppressionPort,
): Promise<boolean> {
  if (suppression && (await suppression.isAppSuppressed(appId))) {
    return true;
  }
  const entity = await entitySuppression(storage);
  if (entity === undefined) return false;
  return sourceCreatedAtMs <= entity.deleteBeforeTsMs;
}

async function entitySuppression(
  storage: HoldoverWriteOutboxStorage,
): Promise<EntityHoldoverWriteSuppression | undefined> {
  const value = await storage.get<EntityHoldoverWriteSuppression | boolean>(
    HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY,
  );
  if (value === true) {
    // Legacy permanent tombstone from pre-cutoff builds.
    return { deleteBeforeTsMs: Number.POSITIVE_INFINITY };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof value.deleteBeforeTsMs === "number" &&
    Number.isFinite(value.deleteBeforeTsMs)
  ) {
    return value;
  }
  return undefined;
}

async function purgeStaleJobs(
  storage: HoldoverWriteOutboxStorage,
  deleteBeforeTsMs: number,
): Promise<void> {
  const jobs = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  for (const [key, job] of jobs) {
    const createdAtMs = typeof job.createdAtMs === "number" ? job.createdAtMs : 0;
    if (createdAtMs <= deleteBeforeTsMs) {
      await storage.delete(key);
    }
  }
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
