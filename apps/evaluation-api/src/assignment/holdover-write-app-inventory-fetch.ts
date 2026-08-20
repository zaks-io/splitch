import {
  appInventoryStatus,
  beginAppInventoryDeletion,
  cancelAppInventoryDeletion,
  type HoldoverWriteAppInventoryStorage,
  isAppInventorySuppressed,
  markAppInventoryEntityPurged,
  registerAppInventoryEntity,
} from "./holdover-write-app-inventory";

type InventoryRoute = (
  storage: HoldoverWriteAppInventoryStorage,
  body: unknown,
) => Promise<Response>;

const inventoryPostRoutes: Record<string, InventoryRoute> = {
  "/register": async (storage, body) => {
    const result = await registerAppInventoryEntity(storage, parseEntityRef(body));
    return Response.json(result);
  },
  "/begin-deletion": async (storage, body) => {
    const result = await beginAppInventoryDeletion(
      storage,
      parseDeleteBefore(body).deleteBeforeTsMs,
    );
    return Response.json(result);
  },
  "/cancel-deletion": async (storage) => {
    return Response.json(await cancelAppInventoryDeletion(storage));
  },
  "/mark-entity-purged": async (storage, body) => {
    await markAppInventoryEntityPurged(storage, parseEntityRef(body));
    return Response.json({ ok: true });
  },
};

const inventoryGetRoutes: Record<
  string,
  (storage: HoldoverWriteAppInventoryStorage) => Promise<Response>
> = {
  "/status": async (storage) => Response.json(await appInventoryStatus(storage)),
  "/suppressed": async (storage) =>
    Response.json({ suppressed: await isAppInventorySuppressed(storage) }),
};

export async function handleHoldoverWriteAppInventoryFetch(
  storage: HoldoverWriteAppInventoryStorage,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    return await dispatchInventoryRoute(storage, request.method, url.pathname, request);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return Response.json({ error: message }, { status: 400 });
  }
}

async function dispatchInventoryRoute(
  storage: HoldoverWriteAppInventoryStorage,
  method: string,
  pathname: string,
  request: Request,
): Promise<Response> {
  if (method === "GET") {
    const get = inventoryGetRoutes[pathname];
    if (get) return get(storage);
  }
  if (method === "POST") {
    const post = inventoryPostRoutes[pathname];
    if (post) {
      const body = pathname === "/cancel-deletion" ? {} : await request.json();
      return post(storage, body);
    }
  }
  return new Response("not found", { status: 404 });
}

function parseEntityRef(value: unknown): { idType: string; targetingKeyHash: string } {
  if (!isRecord(value)) {
    throw new TypeError("holdover-write-app-inventory: expected object payload");
  }
  return {
    idType: requireString(value, "idType"),
    targetingKeyHash: requireString(value, "targetingKeyHash"),
  };
}

function parseDeleteBefore(value: unknown): { deleteBeforeTsMs: number } {
  if (!isRecord(value) || typeof value.deleteBeforeTsMs !== "number") {
    throw new TypeError("holdover-write-app-inventory: deleteBeforeTsMs is required");
  }
  if (!Number.isFinite(value.deleteBeforeTsMs)) {
    throw new TypeError("holdover-write-app-inventory: deleteBeforeTsMs must be finite");
  }
  return { deleteBeforeTsMs: value.deleteBeforeTsMs };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError(`holdover-write-app-inventory: ${key} must be a non-empty string`);
  }
  return field;
}
