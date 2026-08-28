import type { HashedAssignmentPutInput } from "./assignment-store";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import {
  DurableHoldoverWriteAppInventoryClient,
  inventoryRegisterPortForApp,
} from "./holdover-write-app-inventory-client";
import {
  deleteEntityOutbox,
  HOLDOVER_WRITE_JOB_PREFIX,
  type HoldoverWriteJob,
  type HoldoverWriteOutboxLogger,
  type HoldoverWriteOutboxStorage,
  type HoldoverWritePutPort,
  type HoldoverWriteSuppressionPort,
  purgeEntityOutboxState,
  readEntitySuppression,
  suppressEntityOutbox,
} from "./holdover-write-outbox-core";
import {
  ensureHoldoverWriteJob,
  type HoldoverWriteInventoryRegisterPort,
  resumeHoldoverWriteAlarms,
} from "./holdover-write-outbox-ensure";

type OutboxHandler = (
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  request: Request,
  ctx: OutboxFetchContext,
) => Promise<Response>;

interface OutboxFetchContext {
  readonly logger?: HoldoverWriteOutboxLogger;
  readonly nowMs: number;
  readonly suppression?: HoldoverWriteSuppressionPort;
  readonly appInventory?: HoldoverWriteAppInventoryNamespace;
}

const outboxPostRoutes: Record<string, OutboxHandler> = {
  "/delete": async (storage, _put, request, ctx) =>
    deleteResponse(storage, await request.json(), ctx.appInventory),
  "/resume-alarms": async (storage, _put, _request, _ctx) => {
    await resumeHoldoverWriteAlarms(storage);
    return Response.json({ ok: true });
  },
  "/suppress": async (storage, _put, request) => {
    const body = await request.json().catch(() => ({}));
    await suppressEntityOutbox(storage, parseDeleteBeforeTsMs(body));
    return Response.json({ ok: true });
  },
  "/purge": async (storage, _put, request, _ctx) => {
    const body = await request.json().catch(() => ({}));
    const result = await purgeEntityOutboxState(
      storage,
      parseDeleteBeforeTsMs(body, Number.POSITIVE_INFINITY),
    );
    return Response.json({ ok: true, ...result });
  },
  "/ensure": async (storage, putPort, request, ctx) =>
    ensureResponse(storage, putPort, await request.json(), ctx),
};

export async function handleHoldoverWriteOutboxFetch(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  request: Request,
  logger?: HoldoverWriteOutboxLogger,
  nowMs: number = Date.now(),
  suppression?: HoldoverWriteSuppressionPort,
  appInventory?: HoldoverWriteAppInventoryNamespace,
): Promise<Response> {
  const url = new URL(request.url);
  const ctx: OutboxFetchContext = { logger, nowMs, suppression, appInventory };
  if (request.method === "GET" && url.pathname === "/status") {
    return statusResponse(storage);
  }
  if (request.method === "GET" && url.pathname === "/export") {
    return exportResponse(storage);
  }
  if (request.method === "POST") {
    const route = outboxPostRoutes[url.pathname];
    if (route) return route(storage, putPort, request, ctx);
  }
  return new Response("not found", { status: 404 });
}

async function exportResponse(storage: HoldoverWriteOutboxStorage): Promise<Response> {
  const listed = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  return Response.json({
    jobs: [...listed.values()],
    suppression: (await readEntitySuppression(storage)) ?? null,
  });
}

async function deleteResponse(
  storage: HoldoverWriteOutboxStorage,
  body: unknown,
  appInventory: HoldoverWriteAppInventoryNamespace | undefined,
): Promise<Response> {
  const parsed = parseEntityDeleteBody(body);
  const result = await deleteEntityOutbox(storage, parsed.deleteBeforeTsMs);
  // Unregister inside the same DO critical section as purge so a post-cutoff
  // ensure that serializes afterward can re-register cleanly (SPL-346).
  if (!result.remainingJobs && appInventory && parsed.identity) {
    const client = new DurableHoldoverWriteAppInventoryClient(appInventory);
    await client.markEntityPurged(parsed.identity.appId, {
      idType: parsed.identity.idType,
      targetingKeyHash: parsed.identity.targetingKeyHash,
    });
  }
  return Response.json({ ok: true, ...result });
}

async function statusResponse(storage: HoldoverWriteOutboxStorage): Promise<Response> {
  const listed = await storage.list<HoldoverWriteJob>({ prefix: HOLDOVER_WRITE_JOB_PREFIX });
  const jobs = [...listed.values()];
  if (jobs.length === 0) return Response.json({ status: "empty" });
  return Response.json({ jobs });
}

async function ensureResponse(
  storage: HoldoverWriteOutboxStorage,
  putPort: HoldoverWritePutPort,
  body: unknown,
  ctx: OutboxFetchContext,
): Promise<Response> {
  const parsed = parseEnsureRequest(body);
  const inventory: HoldoverWriteInventoryRegisterPort | undefined = ctx.appInventory
    ? inventoryRegisterPortForApp(
        new DurableHoldoverWriteAppInventoryClient(ctx.appInventory),
        parsed.input.appId,
      )
    : undefined;
  const result = await ensureHoldoverWriteJob(
    storage,
    putPort,
    parsed.input,
    ctx.nowMs,
    ctx.logger,
    ctx.suppression,
    { sourceCreatedAtMs: parsed.sourceCreatedAtMs },
    inventory,
  );
  return Response.json(result);
}

function parseEntityDeleteBody(value: unknown): {
  deleteBeforeTsMs: number;
  identity?: { appId: string; idType: string; targetingKeyHash: string };
} {
  const deleteBeforeTsMs = parseDeleteBeforeTsMs(value);
  if (!isRecord(value)) {
    return { deleteBeforeTsMs };
  }
  const appId = value.appId;
  const idType = value.idType;
  const targetingKeyHash = value.targetingKeyHash;
  if (
    typeof appId === "string" &&
    appId.length > 0 &&
    typeof idType === "string" &&
    idType.length > 0 &&
    typeof targetingKeyHash === "string" &&
    targetingKeyHash.length > 0
  ) {
    return { deleteBeforeTsMs, identity: { appId, idType, targetingKeyHash } };
  }
  return { deleteBeforeTsMs };
}

function parseDeleteBeforeTsMs(value: unknown, fallback?: number): number {
  if (isRecord(value) && typeof value.deleteBeforeTsMs === "number") {
    if (!Number.isFinite(value.deleteBeforeTsMs)) {
      throw new TypeError("holdover-write-outbox: deleteBeforeTsMs must be finite");
    }
    return value.deleteBeforeTsMs;
  }
  if (fallback !== undefined) return fallback;
  throw new TypeError("holdover-write-outbox: deleteBeforeTsMs is required");
}

function parseEnsureRequest(value: unknown): {
  input: HashedAssignmentPutInput;
  sourceCreatedAtMs?: number;
} {
  if (!isRecord(value)) {
    throw new TypeError("holdover-write-outbox: expected object payload");
  }
  const input = {
    appId: requireString(value, "appId"),
    experimentId: requireString(value, "experimentId"),
    idType: requireString(value, "idType"),
    targetingKeyHash: requireString(value, "targetingKeyHash"),
    runId: requireString(value, "runId"),
    variant: requireString(value, "variant"),
  };
  let sourceCreatedAtMs: number | undefined;
  if (value.sourceCreatedAtMs !== undefined) {
    if (typeof value.sourceCreatedAtMs !== "number" || !Number.isFinite(value.sourceCreatedAtMs)) {
      throw new TypeError("holdover-write-outbox: sourceCreatedAtMs must be a finite number");
    }
    sourceCreatedAtMs = value.sourceCreatedAtMs;
  }
  const allowed = new Set([...Object.keys(input), "sourceCreatedAtMs"]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new TypeError(`holdover-write-outbox: unexpected payload keys ${extra.join(",")}`);
  }
  return { input, sourceCreatedAtMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`holdover-write-outbox: ${key} must be a non-empty string`);
  }
  return field;
}
