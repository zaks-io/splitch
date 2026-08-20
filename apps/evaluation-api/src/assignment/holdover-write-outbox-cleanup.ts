/**
 * Binding-door deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App delete: two-phase prepare (freeze) / finalize (drain+complete) / cancel
 * (restore). Entity delete: cutoff-aware suppress+purge+inventory unregister.
 *
 * @module
 */

import type { ErrorResponse } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { AssignmentKv } from "./assignment-store";
import type { HoldoverWriteAppInventoryClient } from "./holdover-write-app-inventory-client";
import {
  cancelAppHoldoverWriteDeletion,
  finalizeAppHoldoverWriteDeletion,
  markAppHoldoverWriteD1Deleted,
  prepareAppHoldoverWriteDeletion,
  suppressAndPurgeEntityHoldoverWriteOutbox,
} from "./holdover-write-deletion";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";

type HoldoverWriteAppDeletionPhase = "prepare" | "finalize" | "cancel" | "mark-d1-deleted";

export interface HoldoverWriteOutboxCleanupDeps {
  readonly assignmentsKv: AssignmentKv;
  readonly holdoverWriteOutbox: HoldoverWriteOutboxNamespace;
  readonly holdoverWriteAppInventory: HoldoverWriteAppInventoryClient;
}

export function makeHoldoverWriteOutboxCleanupHandler(deps: HoldoverWriteOutboxCleanupDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      await runHoldoverWriteOutboxCleanup(deps, cleanupScope(input, principal.appId));
      return Response.json({ deleted: true as const });
    } catch (cause) {
      return renderError(cleanupError(cause), { requestId });
    }
  };
}

async function runHoldoverWriteOutboxCleanup(
  deps: HoldoverWriteOutboxCleanupDeps,
  scope: CleanupScope,
): Promise<void> {
  if (scope.kind === "app") {
    await runAppPhase(deps, scope);
    return;
  }
  await suppressAndPurgeEntityHoldoverWriteOutbox(deps.holdoverWriteOutbox, {
    appId: scope.appId,
    idType: scope.idType,
    targetingKeyHash: scope.targetingKeyHash,
    deleteBeforeTsMs: scope.deleteBeforeTsMs,
  });
}

async function runAppPhase(
  deps: HoldoverWriteOutboxCleanupDeps,
  scope: Extract<CleanupScope, { kind: "app" }>,
): Promise<void> {
  switch (scope.phase) {
    case "prepare":
      await prepareAppHoldoverWriteDeletion(
        deps.holdoverWriteAppInventory,
        scope.appId,
        scope.deleteBeforeTsMs ?? Date.now(),
      );
      return;
    case "mark-d1-deleted":
      await markAppHoldoverWriteD1Deleted(
        deps.holdoverWriteAppInventory,
        scope.appId,
        scope.deleteBeforeTsMs,
      );
      return;
    case "finalize":
      await finalizeAppHoldoverWriteDeletion(
        deps.holdoverWriteAppInventory,
        deps.holdoverWriteOutbox,
        scope.appId,
        scope.deleteBeforeTsMs,
      );
      return;
    case "cancel":
      await cancelAppHoldoverWriteDeletion(
        deps.holdoverWriteAppInventory,
        deps.holdoverWriteOutbox,
        scope.appId,
      );
      return;
  }
}

type CleanupScope =
  | {
      readonly kind: "app";
      readonly appId: string;
      readonly deleteBeforeTsMs: number | undefined;
      readonly phase: HoldoverWriteAppDeletionPhase;
    }
  | {
      readonly kind: "entity";
      readonly appId: string;
      readonly idType: string;
      readonly targetingKeyHash: string;
      readonly deleteBeforeTsMs: number;
    };

function cleanupScope(input: unknown, principalAppId: string | null): CleanupScope {
  const parsed = rowObject(input);
  const appId = stringField(rowObject(parsed.params), "appId");
  if (principalAppId !== appId) {
    throw new HoldoverWriteOutboxCleanupForbiddenError();
  }
  const query = rowObject(parsed.query);
  const idType = optionalString(query.idType, "idType");
  const targetingKeyHash = optionalString(query.targetingKeyHash, "targetingKeyHash");
  if (idType === undefined && targetingKeyHash === undefined) {
    const phase = parseAppPhase(query.phase);
    return {
      kind: "app",
      appId,
      phase,
      deleteBeforeTsMs: parseAppDeleteBeforeTs(query.deleteBeforeTs, phase),
    };
  }
  if (idType === undefined || targetingKeyHash === undefined) {
    throw new HoldoverWriteOutboxCleanupValidationError(
      "idType and targetingKeyHash must both be provided for Entity deletion",
    );
  }
  if (query.deleteBeforeTs === undefined) {
    throw new HoldoverWriteOutboxCleanupValidationError(
      "deleteBeforeTs is required for Entity deletion",
    );
  }
  return {
    kind: "entity",
    appId,
    idType,
    targetingKeyHash,
    deleteBeforeTsMs: parseDeleteBeforeTs(query.deleteBeforeTs),
  };
}

function parseAppDeleteBeforeTs(
  value: unknown,
  phase: HoldoverWriteAppDeletionPhase,
): number | undefined {
  if (value === undefined) {
    // prepare defaults to now; finalize/cancel reuse the prepare cutoff in inventory.
    return phase === "prepare" ? Date.now() : undefined;
  }
  return parseDeleteBeforeTs(value);
}

function parseAppPhase(value: unknown): HoldoverWriteAppDeletionPhase {
  if (
    value === "prepare" ||
    value === "finalize" ||
    value === "cancel" ||
    value === "mark-d1-deleted"
  ) {
    return value;
  }
  throw new HoldoverWriteOutboxCleanupValidationError(
    "phase must be prepare, finalize, cancel, or mark-d1-deleted for App deletion",
  );
}

function parseDeleteBeforeTs(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new HoldoverWriteOutboxCleanupValidationError("deleteBeforeTs must be an ISO timestamp");
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new HoldoverWriteOutboxCleanupValidationError("deleteBeforeTs must be an ISO timestamp");
  }
  return ms;
}

function cleanupError(cause: unknown): ErrorResponse {
  if (cause instanceof HoldoverWriteOutboxCleanupForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof HoldoverWriteOutboxCleanupValidationError) {
    return {
      code: "VALIDATION_ERROR",
      message: cause.message,
      details: { issues: [{ path: [], message: cause.message }] },
    };
  }
  return {
    code: "SERVICE_UNAVAILABLE",
    message: "Holdover write outbox cleanup is unavailable",
    details: { retryAfterMs: 30_000 },
  };
}

function rowObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HoldoverWriteOutboxCleanupValidationError("expected object payload");
  }
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new HoldoverWriteOutboxCleanupValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new HoldoverWriteOutboxCleanupValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

class HoldoverWriteOutboxCleanupForbiddenError extends Error {
  constructor() {
    super("cleanup identity is not scoped to the requested App");
    this.name = "HoldoverWriteOutboxCleanupForbiddenError";
  }
}

class HoldoverWriteOutboxCleanupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldoverWriteOutboxCleanupValidationError";
  }
}
