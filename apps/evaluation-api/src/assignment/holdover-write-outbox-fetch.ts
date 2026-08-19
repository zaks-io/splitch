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
  suppressEntityOutbox,
} from "./holdover-write-outbox-core";
import {
  ensureHoldoverWriteJob,
  type HoldoverWriteInventoryRegisterPort,
} from "./holdover-write-outbox-ensure";

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
  if (request.method === "POST" && url.pathname === "/delete") {
    await deleteEntityOutbox(storage, parseDeleteBeforeTsMs(await request.json()));
    return Response.json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/suppress") {
    const body = await request.json().catch(() => ({}));
    await suppressEntityOutbox(storage, parseDeleteBeforeTsMs(body));
    return Response.json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/purge") {
    const body = await request.json().catch(() => ({}));
    await purgeEntityOutboxState(storage, parseDeleteBeforeTsMs(body, Number.POSITIVE_INFINITY));
    return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/status") {
    return statusResponse(storage);
  }
  if (request.method === "POST" && url.pathname === "/ensure") {
    return ensureResponse(
      storage,
      putPort,
      await request.json(),
      nowMs,
      logger,
      suppression,
      appInventory,
    );
  }
  return new Response("not found", { status: 404 });
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
  nowMs: number,
  logger: HoldoverWriteOutboxLogger | undefined,
  suppression: HoldoverWriteSuppressionPort | undefined,
  appInventory: HoldoverWriteAppInventoryNamespace | undefined,
): Promise<Response> {
  const parsed = parseEnsureRequest(body);
  const inventory: HoldoverWriteInventoryRegisterPort | undefined = appInventory
    ? inventoryRegisterPortForApp(
        new DurableHoldoverWriteAppInventoryClient(appInventory),
        parsed.input.appId,
      )
    : undefined;
  const result = await ensureHoldoverWriteJob(
    storage,
    putPort,
    parsed.input,
    nowMs,
    logger,
    suppression,
    { sourceCreatedAtMs: parsed.sourceCreatedAtMs },
    inventory,
  );
  return Response.json(result);
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
