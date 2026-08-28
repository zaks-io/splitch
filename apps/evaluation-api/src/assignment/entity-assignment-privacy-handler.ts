import type { ErrorResponse } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { SaltStore } from "@splitch/privacy";
import type { AssignmentKv } from "./assignment-store";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";
import {
  type AssignmentWriterNamespace,
  deleteEntityAssignments,
  exportEntityAssignments,
} from "./entity-assignment-privacy";

export interface EntityAssignmentPrivacyHandlerDeps {
  assignmentsKv: AssignmentKv;
  assignmentWriters: AssignmentWriterNamespace;
  holdoverWriteOutboxes: HoldoverWriteOutboxNamespace;
  saltStore: SaltStore;
}

export function makeEntityAssignmentPrivacyExportHandler(deps: EntityAssignmentPrivacyHandlerDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = entityPrivacyScope(input, principal.appId);
      const exported = await exportEntityAssignments(
        deps.assignmentsKv,
        deps.holdoverWriteOutboxes,
        deps.saltStore,
        scope,
      );
      return Response.json(exported);
    } catch (cause) {
      return renderError(entityPrivacyError(cause), { requestId });
    }
  };
}

export function makeEntityAssignmentPrivacyDeleteHandler(deps: EntityAssignmentPrivacyHandlerDeps) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = entityPrivacyScope(input, principal.appId);
      if (!scope.deleteBeforeTs) {
        throw new Error("entity assignment privacy delete is missing deleteBeforeTs");
      }
      const deleted = await deleteEntityAssignments(
        deps.assignmentsKv,
        deps.assignmentWriters,
        deps.holdoverWriteOutboxes,
        deps.saltStore,
        scope,
        scope.deleteBeforeTs,
      );
      return Response.json(deleted);
    } catch (cause) {
      return renderError(entityPrivacyError(cause), { requestId });
    }
  };
}

function entityPrivacyScope(
  input: unknown,
  principalAppId: string | null,
): { appId: string; idType: string; targetingKey: string; deleteBeforeTs?: string } {
  const root = asRecord(input);
  const appId = stringField(asRecord(root.params), "appId");
  if (principalAppId !== appId) {
    throw new EntityAssignmentPrivacyForbiddenError();
  }
  const body = asRecord(root.body);
  const deleteBeforeTs = optionalStringField(body, "deleteBeforeTs");
  if (deleteBeforeTs !== undefined && !Number.isFinite(Date.parse(deleteBeforeTs))) {
    throw new Error("entity assignment privacy deleteBeforeTs must be an ISO timestamp");
  }
  return {
    appId,
    idType: stringField(body, "idType"),
    targetingKey: stringField(body, "targetingKey"),
    ...(deleteBeforeTs ? { deleteBeforeTs } : {}),
  };
}

function optionalStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`entity assignment privacy ${key} must be a non-empty string`);
  }
  return field;
}

function entityPrivacyError(cause: unknown): ErrorResponse {
  if (cause instanceof EntityAssignmentPrivacyForbiddenError) {
    return { code: "FORBIDDEN", message: "credential is not scoped to this App", details: {} };
  }
  if (cause instanceof Error && /must not be empty|must not contain/.test(cause.message)) {
    return {
      code: "VALIDATION_ERROR",
      message: cause.message,
      details: { issues: [{ path: [], message: cause.message }] },
    };
  }
  return {
    code: "INTERNAL_SERVER_ERROR",
    message: cause instanceof Error ? cause.message : "entity assignment privacy failed",
    details: {},
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("entity assignment privacy input is not an object");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`entity assignment privacy is missing ${key}`);
  }
  return field;
}

class EntityAssignmentPrivacyForbiddenError extends Error {
  constructor() {
    super("entity assignment privacy is not scoped to this App");
    this.name = "EntityAssignmentPrivacyForbiddenError";
  }
}
