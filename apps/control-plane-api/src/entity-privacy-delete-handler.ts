/**
 * Entity privacy delete (SPL-346 holdover seam): hash Targeting Key, insert
 * `entity_deletions` tombstone, then await the Evaluation holdover-write outbox
 * `/delete` handshake before returning the PrivacyResponse envelope.
 *
 * @module
 */

import { appScope, type Repository } from "@splitch/db";
import { computeTargetingKeyHash, type SaltStore } from "@splitch/privacy";
import type { HandlerArgs, RouteHandler } from "@splitch/worker-runtime";
import { renderError } from "@splitch/worker-runtime";
import { requireAppWrite } from "./app-authz";
import { objectBody, pathParam } from "./handler-input";
import type { HoldoverWriteOutboxCleanup } from "./holdover-write-outbox-cleanup";

const TEN_BUSINESS_DAYS_MS = 10 * 24 * 60 * 60 * 1000;
const FORTY_FIVE_DAYS_MS = 45 * 24 * 60 * 60 * 1000;

export interface EntityPrivacyDeleteDeps {
  readonly repo: Repository;
  readonly saltStore: SaltStore;
  readonly holdoverWriteOutboxCleanup: HoldoverWriteOutboxCleanup;
  readonly nowIso?: () => string;
}

export function makeEntityPrivacyDeleteHandler(
  deps: EntityPrivacyDeleteDeps,
): RouteHandler<unknown> {
  return async (args) => {
    const appId = pathParam(args.input, "appId");
    const authz = await requireAppWrite(deps, appId, args.principal, args.requestId);
    if (authz) return authz;

    const app = await deps.repo.identity.getApp(appId);
    if (!app) {
      return renderError(
        { code: "APP_NOT_FOUND", message: "app not found", details: {} },
        { requestId: args.requestId },
      );
    }

    try {
      return await deleteEntityPrivacy(deps, args, app.id, app.organizationId);
    } catch (cause) {
      return renderError(
        {
          code: "SERVICE_UNAVAILABLE",
          message: cause instanceof Error ? cause.message : "entity privacy delete failed",
          details: { retryAfterMs: 30_000 },
        },
        { requestId: args.requestId },
      );
    }
  };
}

async function deleteEntityPrivacy(
  deps: EntityPrivacyDeleteDeps,
  args: HandlerArgs<unknown>,
  appId: string,
  organizationId: string,
): Promise<Response> {
  const body = objectBody(args.input);
  const idType = requiredString(body, "idType");
  const targetingKey = requiredString(body, "targetingKey");
  const targetingKeyHash = await computeTargetingKeyHash(deps.saltStore, {
    appId,
    idType,
    targetingKey,
  });
  const receivedAt = (deps.nowIso ?? (() => new Date().toISOString()))();
  const receivedAtMs = Date.parse(receivedAt);
  if (!Number.isFinite(receivedAtMs)) {
    throw new Error("entity privacy delete: nowIso must return an ISO timestamp");
  }

  await deps.repo.privacy.entityDeletions.insert(appScope(appId), {
    appId,
    idType,
    targetingKeyHash,
    deleteBeforeTs: receivedAt,
    requestedAt: receivedAt,
  });

  const requestId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await deps.repo.privacy.createPrivacyRequest({
    requestId,
    orgId: organizationId,
    appId,
    requestType: "delete",
    subjectType: "entity",
    subjectRef: JSON.stringify([targetingKeyHash]),
    requestedBy: args.principal.id,
    status: "processing",
    receivedAt,
    ackDueAt: new Date(receivedAtMs + TEN_BUSINESS_DAYS_MS).toISOString(),
    responseDueAt: new Date(receivedAtMs + FORTY_FIVE_DAYS_MS).toISOString(),
  });

  // Cutoff-aware holdover handshake must finish before the PrivacyResponse —
  // stale in-flight puts are serialized by the Evaluation outbox DO.
  await deps.holdoverWriteOutboxCleanup.delete({
    appId,
    idType,
    targetingKeyHash,
    deleteBeforeTs: receivedAt,
    actorId: args.principal.id,
    orgId: organizationId,
    requestId: args.requestId,
  });

  return Response.json({
    request: {
      requestId,
      organizationId,
      appId,
      requestType: "delete",
      subjectType: "entity",
      status: "processing",
      receivedAt,
    },
    job: {
      jobId,
      requestId,
      kind: "delete",
      status: "queued",
    },
  });
}

function requiredString(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}
