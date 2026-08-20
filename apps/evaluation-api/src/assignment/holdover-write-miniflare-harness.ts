/** Test-only source snippets injected around the production Miniflare worker. */

export function holdoverWriteInventoryClientStubs(
  registerFailsRemaining: number,
  suppressPutFailsRemaining: number,
  cancelStatePutFailsRemaining: number,
): string {
  const transportAware = registerFailsRemaining > 0;
  return `
globalThis.__registerFailsRemaining = ${String(registerFailsRemaining)};
globalThis.__suppressPutFailsRemaining = ${String(suppressPutFailsRemaining)};
globalThis.__cancelStatePutFailsRemaining = ${String(cancelStatePutFailsRemaining)};
const CURRENT_KV_SCHEMA_VERSION = 1;
function assignmentWriterName(input) {
  return input.appId + ":" + input.idType + ":" + input.targetingKeyHash;
}
function assignmentKey(appId, idType, targetingKeyHash) {
  return "assignment:" + appId + ":" + idType + ":" + targetingKeyHash;
}
function mergeAssignmentValue(value, input) {
  if (value[input.experimentId] !== undefined) return value;
  return { ...value, [input.experimentId]: { runId: input.runId, variant: input.variant } };
}
function serializeAssignmentValue(value) {
  return JSON.stringify({ schemaVersion: CURRENT_KV_SCHEMA_VERSION, data: value });
}
async function readAssignmentValue(kv, key) {
  const raw = await kv.get(key);
  if (raw === null) return {};
  return JSON.parse(raw).data;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value, key) {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new TypeError("assignment-store: " + key + " must be a non-empty string");
  }
  return field;
}
function failAppSuppressPut(kv) {
  return {
    get: (key) => kv.get(key),
    delete: (key) => kv.delete(key),
    put: async (key, value) => {
      await kv.put(key, value);
      if (globalThis.__suppressPutFailsRemaining > 0) {
        globalThis.__suppressPutFailsRemaining -= 1;
        throw new Error("forced ambiguous App suppress KV put failure");
      }
    },
  };
}
class DurableHoldoverWriteAppInventoryClient {
  constructor(namespace) {
    this.namespace = namespace;
  }
  async registerEntity(appId, ref) {
    const stub = this.namespace.get(this.namespace.idFromName(appId));
    ${
      transportAware
        ? `let response;
    try {
      response = await stub.fetch("https://holdover-write-app-inventory.local/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      });
    } catch (cause) {
      throw new Error("app inventory transport failed", { cause });
    }
    if (!response.ok) {
      throw new Error("app inventory /register returned HTTP " + String(response.status));
    }
    const body = await response.json();
    if (body.status !== "registered" && body.status !== "suppressed") {
      throw new Error("register returned an invalid payload");
    }
    return { status: body.status };`
        : `const response = await stub.fetch("https://holdover-write-app-inventory.local/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ref),
    });
    if (!response.ok) throw new Error("register failed");
    return response.json();`
    }
  }
  async markEntityPurged(appId, ref) {
    const stub = this.namespace.get(this.namespace.idFromName(appId));
    const response = await stub.fetch(
      "https://holdover-write-app-inventory.local/mark-entity-purged",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ref),
      },
    );
    if (!response.ok) {
      throw new Error(${
        transportAware
          ? `"app inventory /mark-entity-purged returned HTTP " + String(response.status)`
          : `"mark-entity-purged failed"`
      });
    }
  }
}
function inventoryRegisterPortForApp(client, appId) {
  return {
    registerEntity: (ref) => client.registerEntity(appId, ref),
  };
}
`;
}

export function holdoverWriteFaultHooks(
  registerFailsRemaining: number,
  suppressPutFailsRemaining: number,
  cancelStatePutFailsRemaining: number,
): string {
  if (
    registerFailsRemaining <= 0 &&
    suppressPutFailsRemaining <= 0 &&
    cancelStatePutFailsRemaining <= 0
  ) {
    return "";
  }
  return `
const __prodInventoryFetch = HoldoverWriteAppInventoryDurableObject.prototype.fetch;
HoldoverWriteAppInventoryDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    await this.alarm();
    return Response.json({ ok: true });
  }
  if (
    url.pathname === "/register" &&
    request.method === "POST" &&
    globalThis.__registerFailsRemaining > 0
  ) {
    globalThis.__registerFailsRemaining -= 1;
    throw new Error("forced register transport failure");
  }
  const originalKv = this.env.ASSIGNMENTS_KV;
  const originalStoragePut = this.ctx.storage.put.bind(this.ctx.storage);
  if (url.pathname === "/begin-deletion" && globalThis.__suppressPutFailsRemaining > 0) {
    this.env.ASSIGNMENTS_KV = failAppSuppressPut(originalKv);
  }
  if (url.pathname === "/begin-deletion" && globalThis.__cancelStatePutFailsRemaining > 0) {
    this.ctx.storage.put = async (key, value) => {
      if (
        key === SAGA_KEY &&
        value?.phase === "canceling" &&
        globalThis.__cancelStatePutFailsRemaining > 0
      ) {
        globalThis.__cancelStatePutFailsRemaining -= 1;
        throw new Error("forced cancel state persistence failure");
      }
      return originalStoragePut(key, value);
    };
  }
  try {
    return await __prodInventoryFetch.call(this, request);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
    this.ctx.storage.put = originalStoragePut;
  }
};
`;
}
