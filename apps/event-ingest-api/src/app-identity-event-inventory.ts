import { evaluationCommitOutbox } from "./evaluation-commit-outbox-client";
import { entityStub, type AppEvaluationCommitRef } from "./entity-metric-privacy";
import type { Env } from "./types";

const APP_ENTITY_PREFIX = "privacy:app-entity:";
const APP_EVALUATION_PREFIX = "privacy:app-evaluation:";
const APP_RESET_SUPPRESSION_KEY = "privacy:app-reset-suppression";

interface AppEntityRef {
  appId: string;
  idType: string;
  entityFamilyHash: string;
}

interface AppResetSuppression {
  resetId: string;
}

export async function registerAppEntity(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const ref = parseAppEntityRef(await request.json());
  if (await storage.get(APP_RESET_SUPPRESSION_KEY)) return suppressed();
  await storage.put(`${APP_ENTITY_PREFIX}${ref.idType}:${ref.entityFamilyHash}`, ref);
  return Response.json({ suppressed: false });
}

export async function registerAppEvaluation(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const ref = parseAppEvaluationRef(await request.json());
  if (await storage.get(APP_RESET_SUPPRESSION_KEY)) return suppressed();
  await storage.put(`${APP_EVALUATION_PREFIX}${ref.commitIdentity}`, ref);
  return Response.json({ suppressed: false });
}

export async function resetAppIdentityDelivery(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (typeof body.appId !== "string" || typeof body.resetId !== "string") {
    throw new Error("App identity reset inventory input is invalid");
  }
  const existing = await storage.get<AppResetSuppression>(APP_RESET_SUPPRESSION_KEY);
  if (existing && existing.resetId !== body.resetId) {
    throw new Error("a different App identity reset is already running");
  }
  await storage.put(APP_RESET_SUPPRESSION_KEY, { resetId: body.resetId });
  const refs = await storage.list<AppEntityRef>({ prefix: APP_ENTITY_PREFIX });
  const commits = await storage.list<AppEvaluationCommitRef>({ prefix: APP_EVALUATION_PREFIX });
  await purgeEvaluationCommits(storage, env, commits);
  await purgeEntities(storage, env, refs, new Date().toISOString());
  return Response.json({
    proof: `event-delivery:entities=${refs.size};evaluation_commits=${commits.size}`,
  });
}

export async function completeAppIdentityDeliveryReset(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const existing = await storage.get<AppResetSuppression>(APP_RESET_SUPPRESSION_KEY);
  if (!existing || body.resetId !== existing.resetId) {
    throw new Error("App identity reset completion does not match suppression");
  }
  const [entities, commits] = await Promise.all([
    storage.list({ prefix: APP_ENTITY_PREFIX }),
    storage.list({ prefix: APP_EVALUATION_PREFIX }),
  ]);
  if (entities.size > 0 || commits.size > 0) {
    throw new Error("App identity reset delivery inventory is not empty");
  }
  await storage.delete(APP_RESET_SUPPRESSION_KEY);
  return Response.json({ completed: true });
}

async function purgeEvaluationCommits(
  storage: DurableObjectStorage,
  env: Env,
  commits: Map<string, AppEvaluationCommitRef>,
): Promise<void> {
  const outbox = evaluationCommitOutbox(env.EVALUATION_COMMIT_OUTBOX);
  if (!outbox) throw new Error("EVALUATION_COMMIT_OUTBOX binding is unavailable");
  for (const [key, ref] of commits) {
    const proof = await outbox.privacyDeleteAll(ref.commitIdentity);
    if (proof !== "evaluation-commit-outbox-purged-v1") {
      throw new Error("App identity reset Evaluation commit purge returned an invalid proof");
    }
    await storage.delete(key);
  }
}

async function purgeEntities(
  storage: DurableObjectStorage,
  env: Env,
  refs: Map<string, AppEntityRef>,
  cutoff: string,
): Promise<void> {
  for (const [key, ref] of refs) {
    const stub = entityStub(env.ENTITY_METRIC_PRIVACY, ref);
    const suppressResponse = await stub.fetch("https://entity-privacy.local/suppress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteBeforeTs: cutoff }),
    });
    if (!suppressResponse.ok) {
      throw new Error(`App identity reset suppression returned ${suppressResponse.status}`);
    }
    const deleteResponse = await stub.fetch("https://entity-privacy.local/delete", {
      method: "POST",
    });
    if (!deleteResponse.ok) {
      throw new Error(`App identity reset deletion returned ${deleteResponse.status}`);
    }
    await storage.delete(key);
  }
}

function parseAppEntityRef(value: unknown): AppEntityRef {
  if (!isRecord(value)) throw new Error("App Entity privacy inventory input is invalid");
  if (
    typeof value.appId !== "string" ||
    typeof value.idType !== "string" ||
    typeof value.entityFamilyHash !== "string"
  ) {
    throw new Error("App Entity privacy inventory input is invalid");
  }
  return {
    appId: value.appId,
    idType: value.idType,
    entityFamilyHash: value.entityFamilyHash,
  };
}

function parseAppEvaluationRef(value: unknown): AppEvaluationCommitRef {
  if (
    !isRecord(value) ||
    typeof value.appId !== "string" ||
    value.appId.length === 0 ||
    typeof value.commitIdentity !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.commitIdentity)
  ) {
    throw new Error("App Evaluation privacy inventory input is invalid");
  }
  return { appId: value.appId, commitIdentity: value.commitIdentity };
}

function suppressed(): Response {
  return Response.json({ suppressed: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
