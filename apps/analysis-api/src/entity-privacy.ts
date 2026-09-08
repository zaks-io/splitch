import type { ErrorResponse } from "@splitch/contracts";
import { type HandlerArgs, renderError } from "@splitch/worker-runtime";
import {
  decodeEntityPrivacyCursor,
  encodeEntityPrivacyCursor,
  type EntityPrivacyCursor,
} from "./entity-privacy-cursor";
import { booleanField, rowObject, stringField } from "./results-row-fields";
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
const ENTITY_PRIVACY_PAGE_MAX_LIMIT = 100;

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
      if (operation === "export") {
        return Response.json(await exportEntity(deps.tinybird, scope, exportPage(input, scope)));
      }
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

async function exportEntity(
  tinybird: TinybirdReadTransport,
  scope: EntityTinybirdPrivacyScope,
  page: { limit: number; cursor: EntityPrivacyCursor | null },
) {
  const records = await tinybird.readPipe("entity_privacy_records", {
    app_id: scope.appId,
    id_type: scope.idType,
    entity_family_hash: scope.entityFamilyHash,
    limit: String(page.limit),
    ...(page.cursor
      ? {
          after_store: page.cursor.store,
          after_record_id: page.cursor.recordId,
          after_server_received_at: page.cursor.serverReceivedAt,
          after_targeting_key_hash: page.cursor.targetingKeyHash,
          after_record_hash: page.cursor.recordHash,
        }
      : {}),
  });
  if (records.length > page.limit) {
    throw new TinybirdReadError("Tinybird Entity export exceeded its requested page limit");
  }
  const rows = records.map(entityRecord);
  const hasMore = rows[0]?.hasMore ?? false;
  if (rows.some((row) => row.hasMore !== hasMore)) {
    throw new TinybirdReadError("Tinybird Entity export returned inconsistent page metadata");
  }
  const parsed = rows.map((row) => row.record);
  const counts = new Map<string, number>(ENTITY_STORES.map((store) => [store, 0]));
  for (const record of parsed) counts.set(record.store, (counts.get(record.store) ?? 0) + 1);
  const last = rows.at(-1)?.cursor;
  if (hasMore && !last) {
    throw new TinybirdReadError("Tinybird Entity export omitted its continuation record");
  }
  return {
    ...identityResult(
      scope,
      ENTITY_STORES.map((store) => `tinybird:${store}:rows=${String(counts.get(store) ?? 0)}`),
    ),
    records: parsed,
    nextCursor:
      hasMore && last ? encodeEntityPrivacyCursor({ ...last, ...scopeIdentity(scope) }) : null,
  };
}

function entityRecord(value: unknown): {
  record: Record<string, unknown> & { store: string };
  cursor: Omit<EntityPrivacyCursor, "appId" | "idType" | "entityFamilyHash">;
  hasMore: boolean;
} {
  const record = rowObject(value);
  const store = stringField(record, "store");
  if (!(ENTITY_STORES as readonly string[]).includes(store)) {
    throw new TinybirdReadError("Tinybird Entity export returned an unknown store");
  }
  const recordId = stringField(record, "record_id");
  const targetingKeyHash = stringField(record, "targeting_key_hash");
  stringField(record, "entity_family_hash");
  stringField(record, "record");
  const serverReceivedAt = stringField(record, "server_received_at");
  const recordHash = stringField(record, "record_hash");
  const hasMore = booleanField(record, "has_more");
  const { has_more: _hasMore, record_hash: _recordHash, ...exported } = record;
  return {
    record: { ...exported, store },
    cursor: { store, recordId, serverReceivedAt, targetingKeyHash, recordHash },
    hasMore,
  };
}

function exportPage(
  input: unknown,
  scope: EntityTinybirdPrivacyScope,
): { limit: number; cursor: EntityPrivacyCursor | null } {
  const body = rowObject(rowObject(input).body);
  const limit = body.limit;
  if (
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > ENTITY_PRIVACY_PAGE_MAX_LIMIT
  ) {
    throw new Error(
      `analysis-api: limit must be an integer in 1..${String(ENTITY_PRIVACY_PAGE_MAX_LIMIT)}`,
    );
  }
  if (body.cursor === null) return { limit: Number(limit), cursor: null };
  if (typeof body.cursor !== "string" || body.cursor.length === 0) {
    throw new Error("analysis-api: Entity privacy cursor must be a string or null");
  }
  const cursor = decodeEntityPrivacyCursor(body.cursor);
  const identity = scopeIdentity(scope);
  if (
    cursor.appId !== identity.appId ||
    cursor.idType !== identity.idType ||
    cursor.entityFamilyHash !== identity.entityFamilyHash
  ) {
    throw new EntityPrivacyForbiddenError();
  }
  return { limit: Number(limit), cursor };
}

function scopeIdentity(scope: EntityTinybirdPrivacyScope) {
  return { appId: scope.appId, idType: scope.idType, entityFamilyHash: scope.entityFamilyHash };
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
