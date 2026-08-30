import {
  type AppEntityRef,
  parseAppEntityRef,
  parseAppEvaluationRef,
  parseEntityIdentityDelivery,
} from "./app-identity-row-input";
import { completeEntityDeliveryPermit } from "./entity-delivery-permit-client";
import {
  type AppEvaluationCommitRef,
  entityStub,
  identityVersionForRow,
} from "./entity-metric-privacy";
import { evaluationCommitOutbox } from "./evaluation-commit-outbox-client";
import {
  hasDeliveryPermits,
  recordDeliveryPermit,
  releaseDeliveryPermit,
} from "./raw-event-delivery-permit";
import { appendRawEvent, tinybirdDelivery } from "./tinybird";
import type { Env } from "./types";

const APP_ENTITY_PREFIX = "privacy:app-entity:";
const APP_EVALUATION_PREFIX = "privacy:app-evaluation:";
const APP_RESET_SUPPRESSION_KEY = "privacy:app-reset-suppression";
const APP_ACTIVE_VERSION_KEY = "privacy:app-active-version";

interface AppResetSuppression {
  resetId: string;
  blockedVersion: string;
}

export async function registerAppEntity(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const ref = parseAppEntityRef(await request.json());
  if (!(await admitVersion(storage, ref.identityVersion))) return suppressed();
  await storage.put(`${APP_ENTITY_PREFIX}${ref.idType}:${ref.entityFamilyHash}`, ref);
  return Response.json({ suppressed: false });
}

export async function registerAppEvaluation(
  storage: DurableObjectStorage,
  request: Request,
): Promise<Response> {
  const ref = parseAppEvaluationRef(await request.json());
  if (!(await admitVersion(storage, ref.identityVersion))) return suppressed();
  await storage.put(`${APP_EVALUATION_PREFIX}${ref.commitIdentity}`, ref);
  return Response.json({ suppressed: false });
}

export async function deliverAppIdentityRow(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (
    !isRecord(body.row) ||
    typeof body.appId !== "string" ||
    body.row.app_id !== body.appId ||
    typeof body.identityVersion !== "string" ||
    identityVersionForRow(body.row) !== body.identityVersion ||
    typeof body.datasource !== "string"
  ) {
    throw new Error("App identity delivery input is invalid");
  }
  if (!(await admitVersion(storage, body.identityVersion))) return suppressed();
  const delivery = tinybirdDelivery(env, body.datasource);
  if (!delivery.ok) throw new Error(delivery.error.message);
  await appendRawEvent(body.row, delivery.value);
  return Response.json({ suppressed: false });
}

export async function deliverEntityIdentityRow(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  return forwardEntityIdentityRow(storage, env, request, "deliver-row");
}

/** The admission half, for queue-backed datasources that batch the append themselves. */
export async function admitEntityIdentityRow(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  return forwardEntityIdentityRow(storage, env, request, "admit-row");
}

async function forwardEntityIdentityRow(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
  entityRoute: "deliver-row" | "admit-row",
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  const { row, datasource, deliveryId, ref } = parseEntityIdentityDelivery(body);
  if (!(await admitVersion(storage, ref.identityVersion))) {
    if (deliveryId !== undefined) {
      await releaseForwardedPermit(storage, env, ref, deliveryId);
    }
    return suppressed();
  }
  await recordForwardedPermit(storage, deliveryId, entityRoute);
  await storage.put(`${APP_ENTITY_PREFIX}${ref.idType}:${ref.entityFamilyHash}`, ref);
  try {
    const response = await entityStub(env.ENTITY_METRIC_PRIVACY, ref).fetch(
      `https://entity-privacy.local/${entityRoute}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasource, row, deliveryId }),
      },
    );
    if (!response.ok) throw new Error(`Entity identity delivery returned ${response.status}`);
    const result = (await response.json()) as { suppressed?: unknown };
    if (typeof result.suppressed !== "boolean") {
      throw new Error("Entity identity delivery returned an invalid result");
    }
    if (result.suppressed && deliveryId !== undefined) {
      await releaseForwardedPermit(storage, env, ref, deliveryId);
    }
    return Response.json(result);
  } catch (error) {
    if (deliveryId !== undefined) await releaseForwardedPermit(storage, env, ref, deliveryId);
    throw error;
  }
}

async function recordForwardedPermit(
  storage: DurableObjectStorage,
  deliveryId: string | undefined,
  entityRoute: "deliver-row" | "admit-row",
): Promise<void> {
  if (entityRoute === "admit-row") await recordDeliveryPermit(storage, deliveryId);
}

async function releaseForwardedPermit(
  storage: DurableObjectStorage,
  env: Env,
  ref: AppEntityRef,
  deliveryId: string,
): Promise<void> {
  try {
    await completeEntityDeliveryPermit(env.ENTITY_METRIC_PRIVACY, ref, deliveryId);
  } finally {
    await releaseDeliveryPermit(storage, deliveryId);
  }
}

export async function resetAppIdentityDelivery(
  storage: DurableObjectStorage,
  env: Env,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  if (
    typeof body.appId !== "string" ||
    typeof body.resetId !== "string" ||
    typeof body.currentVersion !== "string"
  ) {
    throw new Error("App identity reset inventory input is invalid");
  }
  const existing = await storage.get<AppResetSuppression>(APP_RESET_SUPPRESSION_KEY);
  if (existing && existing.resetId !== body.resetId) {
    throw new Error("a different App identity reset is already running");
  }
  const activeVersion = await storage.get<string>(APP_ACTIVE_VERSION_KEY);
  if (activeVersion !== undefined && activeVersion !== body.currentVersion) {
    throw new Error("App identity reset current version does not match delivery generation");
  }
  await storage.put(APP_RESET_SUPPRESSION_KEY, {
    resetId: body.resetId,
    blockedVersion: body.currentVersion,
  });
  if (await hasDeliveryPermits(storage)) {
    return new Response("raw event deliveries are pending", { status: 409 });
  }
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
  const activeVersion = await storage.get<string>(APP_ACTIVE_VERSION_KEY);
  if (
    existing === undefined &&
    typeof body.nextVersion === "string" &&
    activeVersion === body.nextVersion
  ) {
    return Response.json({ completed: true });
  }
  if (
    !existing ||
    body.resetId !== existing.resetId ||
    typeof body.nextVersion !== "string" ||
    body.nextVersion === existing.blockedVersion
  ) {
    throw new Error("App identity reset completion does not match suppression");
  }
  const [entities, commits] = await Promise.all([
    storage.list({ prefix: APP_ENTITY_PREFIX }),
    storage.list({ prefix: APP_EVALUATION_PREFIX }),
  ]);
  if (entities.size > 0 || commits.size > 0) {
    throw new Error("App identity reset delivery inventory is not empty");
  }
  await storage.put(APP_ACTIVE_VERSION_KEY, body.nextVersion);
  await storage.delete(APP_RESET_SUPPRESSION_KEY);
  return Response.json({ completed: true });
}

export async function admitVersion(
  storage: DurableObjectStorage,
  identityVersion: string,
): Promise<boolean> {
  if ((await storage.get(APP_RESET_SUPPRESSION_KEY)) !== undefined) return false;
  const active = await storage.get<string>(APP_ACTIVE_VERSION_KEY);
  if (active === undefined) {
    await storage.put(APP_ACTIVE_VERSION_KEY, identityVersion);
    return true;
  }
  return active === identityVersion;
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

function suppressed(): Response {
  return Response.json({ suppressed: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
