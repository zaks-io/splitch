import { createRepository, type Repository } from "@splitch/db";
import { durableConfigStoreAccess } from "./config-store-access";
import { createEntityPrivacyConsumer, type EntityPrivacyConsumer } from "./entity-privacy-consumer";
import { runEntityDeleteJob } from "./entity-privacy-delete-job";
import {
  PRIVACY_EXPORT_RETENTION_MS,
  writeEntityPrivacyExport,
} from "./entity-privacy-export-artifact";
import type { ResolvedEntityPrivacyInput } from "./entity-privacy-service-client";
import type { ControlPlaneApiEnv } from "./env";

const PRIVACY_JOB_LEASE_MS = 15 * 60 * 1000;
const RECONCILE_DELAY_MS = 60 * 1000;
const RECONCILE_LIMIT = 100;
const RETRY_MAX_SECONDS = 15 * 60;
const PRIVACY_JOB_QUEUE_NAMES = new Set([
  "splitch-privacy-jobs-local",
  "splitch-privacy-jobs-shared-preview",
  "splitch-privacy-jobs",
]);

export interface PrivacyJobMessage {
  requestId: string;
}

export function initialEntityExportStoreStatus() {
  return { assignments: "pending", analysis: "pending", "event-ingest": "pending" } as const;
}

export async function handlePrivacyJobQueue(
  batch: MessageBatch<PrivacyJobMessage>,
  env: ControlPlaneApiEnv,
  ctx: ExecutionContext,
): Promise<void> {
  if (!PRIVACY_JOB_QUEUE_NAMES.has(batch.queue)) {
    throw new Error(`control-plane-api received an unknown queue: ${batch.queue}`);
  }
  for (const message of batch.messages) {
    try {
      await runPrivacyJob(env, ctx, privacyRequestId(message.body));
      message.ack();
    } catch (cause) {
      console.error("control-plane-api privacy job failed", {
        requestId: safeMessageRequestId(message.body),
        attempt: message.attempts,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

export async function reconcilePrivacyJobs(
  env: ControlPlaneApiEnv,
  now = new Date(),
): Promise<number> {
  const repo = createRepository(env.DB);
  const jobs = await repo.privacy.listPrivacyJobsForReconciliation({
    now: now.toISOString(),
    updatedBefore: new Date(now.getTime() - RECONCILE_DELAY_MS).toISOString(),
    limit: RECONCILE_LIMIT,
  });
  for (const job of jobs) await env.PRIVACY_JOBS_QUEUE.send({ requestId: job.requestId });
  return jobs.length;
}

export async function purgeExpiredPrivacyArtifacts(
  env: ControlPlaneApiEnv,
  now = new Date(),
): Promise<number> {
  const repo = createRepository(env.DB);
  const jobs = await repo.privacy.listExpiredPrivacyArtifacts(now.toISOString(), RECONCILE_LIMIT);
  for (const job of jobs) {
    if (!job.artifactKey) continue;
    await env.PRIVACY_EXPORTS.delete(job.artifactKey);
    await repo.privacy.clearPrivacyArtifact(job.requestId, job.artifactKey, now.toISOString());
  }
  return jobs.length;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One leased dispatch boundary owns claim, cleanup, and failure state for both privacy job kinds.
async function runPrivacyJob(
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  requestId: string,
): Promise<void> {
  const repo = createRepository(env.DB);
  const [request, existing] = await Promise.all([
    repo.privacy.getPrivacyRequestById(requestId),
    repo.privacy.getPrivacyJobByRequestId(requestId),
  ]);
  if (!request || !existing) throw new Error("privacy job has no durable intake record");
  if (existing.status === "completed") return;
  const now = new Date();
  const claimToken = crypto.randomUUID();
  const claimed = await repo.privacy.claimPrivacyJob(
    requestId,
    now.toISOString(),
    new Date(now.getTime() + PRIVACY_JOB_LEASE_MS).toISOString(),
    claimToken,
  );
  if (!claimed) return;
  if (
    claimed.status !== "running" ||
    !claimed.leaseExpiresAt ||
    claimed.claimToken !== claimToken
  ) {
    throw new Error("privacy job claim did not establish a lease");
  }
  const entity = entityInput(request, claimed);
  const consumer = createEntityPrivacyConsumer(
    env.EVALUATION_API,
    env.ANALYSIS_API,
    env.EVENT_INGEST_API,
  );
  if (!consumer) throw new Error("Entity privacy consumers are unavailable");
  const renewLease = privacyLeaseRenewer(repo, requestId, claimToken);
  const artifactKey =
    claimed.kind === "export" ? privacyExportArtifactKey(entity, crypto.randomUUID()) : undefined;
  try {
    if (claimed.kind === "export") {
      if (claimed.artifactKey) await env.PRIVACY_EXPORTS.delete(claimed.artifactKey);
      await runPrivacyExport(
        repo,
        env.PRIVACY_EXPORTS,
        consumer,
        entity,
        artifactKey as string,
        claimToken,
        renewLease,
      );
      return;
    }
    await runPrivacyDelete(repo, env, ctx, consumer, entity, claimed, renewLease);
  } catch (cause) {
    if (claimed.kind === "export") {
      if (artifactKey) await env.PRIVACY_EXPORTS.delete(artifactKey).catch(() => undefined);
    }
    const current = await repo.privacy.getPrivacyJobByRequestId(requestId);
    if (current?.status === "running" && current.claimToken === claimToken) {
      await repo.privacy.updatePrivacyJob({
        requestId,
        status: "failed",
        storeStatusJson: current.storeStatusJson,
        updatedAt: new Date().toISOString(),
        errorCode: "PRIVACY_JOB_FAILED",
        claimToken,
      });
    }
    throw cause;
  }
}

async function runPrivacyExport(
  repo: Repository,
  bucket: R2Bucket,
  consumer: EntityPrivacyConsumer,
  entity: ResolvedEntityPrivacyInput,
  artifactKey: string,
  claimToken: string,
  renewLease: () => Promise<void>,
): Promise<void> {
  const expiresAt = new Date(Date.now() + PRIVACY_EXPORT_RETENTION_MS).toISOString();
  await repo.privacy.stagePrivacyExportArtifact({
    requestId: entity.requestId,
    artifactKey,
    artifactExpiresAt: expiresAt,
    updatedAt: new Date().toISOString(),
    claimToken,
  });
  const artifact = await writeEntityPrivacyExport({
    bucket,
    consumer,
    entity,
    requestId: entity.requestId,
    artifactKey,
    expiresAt,
    renewLease,
  });
  await renewLease();
  await repo.privacy.completePrivacyExport({
    requestId: entity.requestId,
    storeStatusJson: JSON.stringify({
      assignments: "done",
      analysis: "done",
      "event-ingest": "done",
    }),
    ...artifact,
    artifactExpiresAt: expiresAt,
    updatedAt: new Date().toISOString(),
    claimToken,
  });
}

async function runPrivacyDelete(
  repo: Repository,
  env: ControlPlaneApiEnv,
  ctx: Pick<ExecutionContext, "waitUntil">,
  consumer: EntityPrivacyConsumer,
  entity: ResolvedEntityPrivacyInput,
  claimed: NonNullable<Awaited<ReturnType<Repository["privacy"]["getPrivacyJobByRequestId"]>>>,
  renewLease: () => Promise<void>,
): Promise<void> {
  const configStore = durableConfigStoreAccess(env.CONFIG_STORE_WRITER, env.CONFIG_STORE, {
    repo,
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
  const recordDeletion = configStore.recordEntityDeletionSuppression;
  if (!recordDeletion) throw new Error("Entity privacy identity coordinator is unavailable");
  await runEntityDeleteJob({
    repo,
    coordinator: { recordEntityDeletionSuppression: recordDeletion.bind(configStore) },
    consumer,
    input: entity,
    identity: entity,
    requestId: entity.requestId,
    job: { ...claimed, status: "running", claimToken: claimed.claimToken as string },
    renewLease,
  });
}

function privacyExportArtifactKey(entity: ResolvedEntityPrivacyInput, attemptId: string): string {
  return `privacy-exports/${entity.appId}/${entity.requestId}/${attemptId}.json`;
}

function entityInput(
  request: NonNullable<Awaited<ReturnType<Repository["privacy"]["getPrivacyRequestById"]>>>,
  job: NonNullable<Awaited<ReturnType<Repository["privacy"]["getPrivacyJobByRequestId"]>>>,
): ResolvedEntityPrivacyInput {
  if (!request.appId || !job.idType || !job.entityFamilyHash) {
    throw new Error("privacy job omitted durable Entity identity");
  }
  const targetingKeyHashes: unknown = JSON.parse(request.subjectRef);
  if (
    !Array.isArray(targetingKeyHashes) ||
    targetingKeyHashes.length === 0 ||
    targetingKeyHashes.some((hash) => typeof hash !== "string" || hash.length === 0)
  ) {
    throw new Error("privacy request has malformed Entity hashes");
  }
  return {
    appId: request.appId,
    idType: job.idType,
    targetingKeyHashes: targetingKeyHashes as string[],
    entityFamilyHash: job.entityFamilyHash,
    actorId: request.requestedBy,
    orgId: request.orgId,
    requestId: request.requestId,
  };
}

function privacyLeaseRenewer(
  repo: Repository,
  requestId: string,
  claimToken: string,
): () => Promise<void> {
  return async () => {
    const now = new Date();
    const renewed = await repo.privacy.renewPrivacyJobLease({
      requestId,
      claimToken,
      leaseExpiresAt: new Date(now.getTime() + PRIVACY_JOB_LEASE_MS).toISOString(),
      updatedAt: now.toISOString(),
    });
    if (!renewed) throw new Error("privacy job lease was lost");
  };
}

function privacyRequestId(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).some((key) => key !== "requestId") ||
    typeof (value as { requestId?: unknown }).requestId !== "string"
  ) {
    throw new Error("privacy queue message is invalid");
  }
  return (value as { requestId: string }).requestId;
}

function safeMessageRequestId(value: unknown): string | null {
  return typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "requestId") === "string"
    ? (Reflect.get(value, "requestId") as string)
    : null;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(5 * 2 ** Math.max(0, attempt - 1), RETRY_MAX_SECONDS);
}
