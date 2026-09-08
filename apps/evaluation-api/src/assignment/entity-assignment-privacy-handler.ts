import type { ErrorResponse } from "@splitch/contracts";
import type { SaltStore } from "@splitch/privacy";
import { type EntityPrivacyIdentity, resolveEntityPrivacyIdentity } from "@splitch/privacy";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import type { AssignmentKv } from "./assignment-store";
import { exportEntityAssignmentsPage } from "./entity-assignment-export";
import {
  type AssignmentWriterNamespace,
  deleteEntityAssignments,
  deleteResolvedEntityAssignments,
  exportEntityAssignments,
} from "./entity-assignment-privacy";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";

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
      if (scope.limit !== undefined) {
        const identity = await identityForScope(deps.saltStore, scope);
        return Response.json(
          await exportEntityAssignmentsPage(
            deps.assignmentsKv,
            deps.assignmentWriters,
            deps.holdoverWriteOutboxes,
            identity,
            scope.cursor ?? null,
            scope.limit,
          ),
        );
      }
      if (!("targetingKey" in scope)) {
        throw new Error("resolved Entity assignment export requires pagination");
      }
      const exported = await exportEntityAssignments(
        deps.assignmentsKv,
        deps.assignmentWriters,
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
      const deleted =
        "targetingKey" in scope
          ? await deleteEntityAssignments(
              deps.assignmentWriters,
              deps.holdoverWriteOutboxes,
              deps.saltStore,
              scope,
              scope.deleteBeforeTs,
            )
          : await deleteResolvedEntityAssignments(
              deps.assignmentWriters,
              deps.holdoverWriteOutboxes,
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
): ({ appId: string; idType: string; targetingKey: string } | EntityPrivacyIdentity) & {
  deleteBeforeTs?: string;
  cursor?: string | null;
  limit?: number;
} {
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
  const identity = assignmentIdentity(body, appId);
  const cursor = optionalNullableStringField(body, "cursor");
  const limit = optionalIntegerField(body, "limit");
  return {
    appId,
    idType: stringField(body, "idType"),
    ...identity,
    ...(deleteBeforeTs ? { deleteBeforeTs } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function assignmentIdentity(
  body: Record<string, unknown>,
  appId: string,
): { targetingKey: string } | Omit<EntityPrivacyIdentity, "appId" | "idType"> {
  if (typeof body.targetingKey === "string" && body.targetingKey.length > 0) {
    return { targetingKey: body.targetingKey };
  }
  if (
    !Array.isArray(body.targetingKeyHashes) ||
    body.targetingKeyHashes.length === 0 ||
    body.targetingKeyHashes.some((value) => typeof value !== "string" || value.length === 0) ||
    typeof body.entityFamilyHash !== "string" ||
    body.entityFamilyHash.length === 0
  ) {
    throw new Error(`entity assignment privacy ${appId} is missing Entity identity`);
  }
  return {
    targetingKeyHashes: body.targetingKeyHashes as string[],
    entityFamilyHash: body.entityFamilyHash,
  };
}

async function identityForScope(
  saltStore: SaltStore,
  scope: ReturnType<typeof entityPrivacyScope>,
): Promise<EntityPrivacyIdentity> {
  return "targetingKey" in scope
    ? resolveEntityPrivacyIdentity(saltStore, scope)
    : {
        appId: scope.appId,
        idType: scope.idType,
        targetingKeyHashes: scope.targetingKeyHashes,
        entityFamilyHash: scope.entityFamilyHash,
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

function optionalNullableStringField(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const field = value[key];
  if (field === undefined || field === null) return field;
  if (typeof field !== "string") throw new Error(`entity assignment privacy ${key} is invalid`);
  return field;
}

function optionalIntegerField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (!Number.isInteger(field) || Number(field) < 1 || Number(field) > 100) {
    throw new Error(`entity assignment privacy ${key} is invalid`);
  }
  return Number(field);
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
