import type { ErrorResponse } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import { rowObject, stringField } from "./results-row-fields";
import { TinybirdReadError, type TinybirdReadTransport } from "./tinybird";
import {
  type EntityTinybirdPrivacyScope,
  TinybirdDeleteError,
  type TinybirdDeleteTransport,
} from "./tinybird-delete";

const ENTITY_STORES = [
  "raw_events",
  "metric_events",
  "deduped_exposures",
  "deduped_metric_events_state",
] as const;

export interface EntityPrivacyDeps {
  tinybird: TinybirdReadTransport;
  tinybirdDelete: TinybirdDeleteTransport;
}

export function makeEntityPrivacyHandler(
  deps: EntityPrivacyDeps,
  operation: "export" | "suppress" | "delete",
) {
  return async ({ input, principal, requestId }: HandlerArgs<unknown>): Promise<Response> => {
    try {
      const scope = entityScope(input, principal.appId, operation !== "export");
      if (operation === "export") return Response.json(await exportEntity(deps.tinybird, scope));
      const mutate =
        operation === "suppress"
          ? deps.tinybirdDelete.suppressEntity
          : deps.tinybirdDelete.deleteEntity;
      if (!mutate) throw new TinybirdDeleteError("Tinybird Entity privacy adapter is unavailable");
      const proofs = await mutate(scope);
      return Response.json(identityResult(scope, proofs));
    } catch (cause) {
      return renderError(entityPrivacyError(cause), { requestId });
    }
  };
}

async function exportEntity(tinybird: TinybirdReadTransport, scope: EntityTinybirdPrivacyScope) {
  const records = await tinybird.readPipe("entity_privacy_records", {
    app_id: scope.appId,
    id_type: scope.idType,
    entity_family_hash: scope.entityFamilyHash,
  });
  const parsed = records.map(entityRecord);
  const counts = new Map<string, number>(ENTITY_STORES.map((store) => [store, 0]));
  for (const record of parsed) counts.set(record.store, (counts.get(record.store) ?? 0) + 1);
  return {
    ...identityResult(
      scope,
      ENTITY_STORES.map((store) => `tinybird:${store}:rows=${String(counts.get(store) ?? 0)}`),
    ),
    records: parsed,
  };
}

function entityRecord(value: unknown): Record<string, unknown> & { store: string } {
  const record = rowObject(value);
  const store = stringField(record, "store");
  if (!(ENTITY_STORES as readonly string[]).includes(store)) {
    throw new TinybirdReadError("Tinybird Entity export returned an unknown store");
  }
  stringField(record, "record_id");
  stringField(record, "targeting_key_hash");
  stringField(record, "entity_family_hash");
  stringField(record, "record");
  return { ...record, store };
}

function identityResult(scope: EntityTinybirdPrivacyScope, proofs: readonly string[]) {
  if (proofs.length === 0 || proofs.some((proof) => proof.length === 0)) {
    throw new TinybirdDeleteError("Tinybird Entity privacy operation omitted store proof");
  }
  return {
    appId: scope.appId,
    idType: scope.idType,
    targetingKeyHashes: scope.targetingKeyHashes,
    entityFamilyHash: scope.entityFamilyHash,
    proofs,
  };
}

function entityScope(
  input: unknown,
  principalAppId: string | null,
  requireDeleteBefore: boolean,
): EntityTinybirdPrivacyScope {
  const parsed = rowObject(input);
  const appId = stringField(rowObject(parsed.params), "appId");
  if (principalAppId !== appId) throw new EntityPrivacyForbiddenError();
  const body = rowObject(parsed.body);
  const targetingKeyHashes = stringArray(body.targetingKeyHashes, "targetingKeyHashes");
  return {
    appId,
    idType: stringField(body, "idType"),
    targetingKeyHashes,
    entityFamilyHash: stringField(body, "entityFamilyHash"),
    deleteBeforeTs: requireDeleteBefore
      ? stringField(body, "deleteBeforeTs")
      : new Date(0).toISOString(),
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`analysis-api: ${name} must be a non-empty string array`);
  }
  return value as string[];
}

function entityPrivacyError(cause: unknown): ErrorResponse {
  if (cause instanceof EntityPrivacyForbiddenError) {
    return { code: "FORBIDDEN", message: cause.message, details: {} };
  }
  if (cause instanceof TinybirdReadError || cause instanceof TinybirdDeleteError) {
    return {
      code: "SERVICE_UNAVAILABLE",
      message: "Entity privacy storage is unavailable",
      details: { retryAfterMs: 30_000 },
    };
  }
  return { code: "INTERNAL_SERVER_ERROR", message: "Entity privacy operation failed", details: {} };
}

class EntityPrivacyForbiddenError extends Error {
  constructor() {
    super("Entity privacy identity is not scoped to the requested App");
    this.name = "EntityPrivacyForbiddenError";
  }
}
