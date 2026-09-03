import { assignmentWriterName } from "@splitch/contracts";
import { extendAppIdentityResetFence } from "./app-identity-reset-fence";
import type { HashedAssignmentPutInput } from "./assignment-store";

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

export interface HoldoverWriteOutboxPurgeResult {
  readonly remainingJobs: boolean;
}

export interface HoldoverWriteOutboxAppResetProof {
  readonly jobs: readonly HoldoverWriteJob[];
  readonly fencedIdentityVersions: readonly string[];
  readonly proof: "holdover-write-outbox-app-reset-v1";
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
export interface EntityHoldoverWriteSuppression {
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

export function holdoverWriteJobDueAtMs(job: HoldoverWriteJob): number {
  return job.updatedAtMs + holdoverWriteRetryDelayMs(Math.max(1, job.attempt));
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
 * Purge pending / poisoned job rows at or before the Entity cutoff (hashes),
 * then preserve scheduling for newer pending jobs. Keeps the Entity suppress
 * tombstone so a stale post-deletion retry cannot recreate Assignment Store state.
 */
export async function purgeEntityOutboxState(
  storage: HoldoverWriteOutboxStorage,
  deleteBeforeTsMs: number = Number.POSITIVE_INFINITY,
): Promise<HoldoverWriteOutboxPurgeResult> {
  await purgeStaleJobs(storage, deleteBeforeTsMs);
  return { remainingJobs: await reschedulePendingHoldoverWriteAlarm(storage) };
}

/** Full Entity deletion handshake: suppress → purge stale under one critical section. */
export async function deleteEntityOutbox(
  storage: HoldoverWriteOutboxStorage,
  deleteBeforeTsMs: number,
): Promise<HoldoverWriteOutboxPurgeResult> {
  await suppressEntityOutbox(storage, deleteBeforeTsMs);
  return purgeEntityOutboxState(storage, deleteBeforeTsMs);
}

export async function resetAppOutboxState(
  storage: HoldoverWriteOutboxStorage,
  destroyedVersions: readonly string[],
): Promise<HoldoverWriteOutboxAppResetProof> {
  const fencedIdentityVersions = await extendAppIdentityResetFence(storage, destroyedVersions);
  const jobs = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  for (const key of jobs.keys()) await storage.delete(key);
  await storage.deleteAlarm();
  const remaining = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  if (remaining.size > 0)
    throw new Error("holdover-write-outbox: App reset purge proof is not empty");
  return {
    jobs: [...remaining.values()],
    fencedIdentityVersions,
    proof: "holdover-write-outbox-app-reset-v1",
  };
}

export async function purgeStaleJobs(
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

export async function reschedulePendingHoldoverWriteAlarm(
  storage: HoldoverWriteOutboxStorage,
): Promise<boolean> {
  const jobs = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  const pending = [...jobs.values()].filter((job) => job.status === "pending");
  if (pending.length === 0) {
    await storage.deleteAlarm();
    return jobs.size > 0;
  }
  await storage.setAlarm(Math.min(...pending.map(holdoverWriteJobDueAtMs)));
  return true;
}

export async function readEntitySuppression(
  storage: HoldoverWriteOutboxStorage,
): Promise<EntityHoldoverWriteSuppression | undefined> {
  const value = await storage.get<EntityHoldoverWriteSuppression | boolean>(
    HOLDOVER_WRITE_ENTITY_SUPPRESSED_KEY,
  );
  if (value === true) {
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
