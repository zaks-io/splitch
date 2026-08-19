/**
 * Binding-door deletion consumer for the holdover-write outbox (SPL-346).
 *
 * App delete (no entity query): suppress App-wide pending/alarm puts via KV
 * tombstone. Entity delete (idType + targetingKeyHash): suppress then purge
 * that Entity's outbox DO so hashes cannot linger and puts cannot recreate
 * Assignment Store state.
 *
 * @module
 */

import type { ErrorResponse } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { AssignmentKv } from "./assignment-store";
import {
  suppressAndPurgeEntityHoldoverWriteOutbox,
  suppressAppHoldoverWriteOutbox,
} from "./holdover-write-deletion";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";

export interface HoldoverWriteOutboxCleanupDeps {
  readonly assignmentsKv: AssignmentKv;
  readonly holdoverWriteOutbox: HoldoverWriteOutboxNamespace;
}

export function makeHoldoverWriteOutboxCleanupHandler(deps: HoldoverWriteOutboxCleanupDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = cleanupScope(input, principal.appId);
      if (scope.kind === "app") {
        await suppressAppHoldoverWriteOutbox(deps.assignmentsKv, scope.appId);
      } else {
        await suppressAndPurgeEntityHoldoverWriteOutbox(deps.holdoverWriteOutbox, {
          appId: scope.appId,
          idType: scope.idType,
          targetingKeyHash: scope.targetingKeyHash,
        });
      }
      return Response.json({ deleted: true as const });
    } catch (cause) {
      return renderError(cleanupError(cause), { requestId });
    }
  };
}

type CleanupScope =
  | { readonly kind: "app"; readonly appId: string }
  | {
      readonly kind: "entity";
      readonly appId: string;
      readonly idType: string;
      readonly targetingKeyHash: string;
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
    return { kind: "app", appId };
  }
  if (idType === undefined || targetingKeyHash === undefined) {
    throw new HoldoverWriteOutboxCleanupValidationError(
      "idType and targetingKeyHash must both be provided for Entity deletion",
    );
  }
  return { kind: "entity", appId, idType, targetingKeyHash };
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
