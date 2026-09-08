import { appScope, createRepository } from "@splitch/db";
import { assertAppIdentityTrafficAllowed, requireAppIdentityRecord } from "@splitch/privacy";
import { configStoreAppIdentityStore } from "./config-store-app-identity";
import type { ControlPlaneApiEnv } from "./env";

export interface EntityPrivacyLedgerInput {
  requestId: string;
  jobId: string;
  orgId: string;
  appId: string;
  requestType: "export" | "delete";
  subjectRef: string;
  requestedBy: string;
  receivedAt: string;
  ackDueAt: string;
  responseDueAt: string;
  idempotencyKey: string;
  requestHash: string;
  storeStatusJson: string;
  deleteBeforeTs: string | null;
  identityVersion: string;
  idType: string;
  entityFamilyHash: string;
}

export interface EntityPrivacyLedgerRecord {
  request: {
    requestId: string;
    orgId: string;
    appId: string | null;
    requestType: string;
    subjectType: string;
    status: string;
    receivedAt: string;
    requestHash: string | null;
  };
  job: {
    jobId: string;
    requestId: string;
    kind: "export" | "delete";
    status: "queued" | "running" | "completed" | "failed";
    storeStatusJson: string;
    deleteBeforeTs: string | null;
    identityVersion: string;
    idType: string | null;
    entityFamilyHash: string | null;
  };
}

export function beginConfigStoreEntityPrivacy(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
): Promise<string> {
  return ctx.blockConcurrencyWhile(async () => {
    const record = await activeRecord(ctx, env, appId);
    return record.currentVersion;
  });
}

export function recordConfigStoreEntityDeletionSuppression(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  expectedVersion: string,
  input: { idType: string; targetingKeyHashes: readonly string[]; deleteBeforeTs: string },
): Promise<void> {
  return ctx.blockConcurrencyWhile(async () => {
    await requireExpectedVersion(ctx, env, appId, expectedVersion);
    const repo = createRepository(env.DB);
    for (const targetingKeyHash of input.targetingKeyHashes) {
      const existing = await repo.privacy.findEntityDeletion(appScope(appId), {
        idType: input.idType,
        targetingKeyHash,
        deleteBeforeTs: input.deleteBeforeTs,
      });
      if (existing) continue;
      await repo.privacy.entityDeletions.insert(appScope(appId), {
        appId,
        idType: input.idType,
        targetingKeyHash,
        deleteBeforeTs: input.deleteBeforeTs,
        requestedAt: input.deleteBeforeTs,
      });
    }
  });
}

export function recordConfigStoreEntityPrivacyRequest(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  expectedVersion: string,
  input: EntityPrivacyLedgerInput,
): Promise<EntityPrivacyLedgerRecord> {
  return ctx.blockConcurrencyWhile(async () => {
    await requireExpectedVersion(ctx, env, appId, expectedVersion);
    return createRepository(env.DB).privacy.beginEntityPrivacyJob(input);
  });
}

async function requireExpectedVersion(
  ctx: DurableObjectState,
  env: ControlPlaneApiEnv,
  appId: string,
  expectedVersion: string,
): Promise<void> {
  const record = await activeRecord(ctx, env, appId);
  if (record.currentVersion !== expectedVersion) {
    throw new Error("config-store: App identity changed during Entity privacy request");
  }
}

async function activeRecord(ctx: DurableObjectState, env: ControlPlaneApiEnv, appId: string) {
  const record = await requireAppIdentityRecord(
    configStoreAppIdentityStore(ctx, env, appId),
    appId,
  );
  assertAppIdentityTrafficAllowed(record.lifecycle);
  return record;
}
