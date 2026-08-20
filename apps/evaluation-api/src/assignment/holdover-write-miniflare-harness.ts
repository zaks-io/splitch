/** Test-only source snippets injected around the production Miniflare worker. */

export function holdoverWriteInventoryClientStubs(
  registerFailsRemaining: number,
  suppressPutFailsRemaining: number,
  cancelStatePutFailsRemaining: number,
  cancelKvDeleteFailsRemaining: number,
  staleSuppressionReadsRemaining: number,
  writerPutFailsRemaining: number,
  purgeFailsRemaining: number,
  markTransactionFailsBeforeCommitRemaining: number,
  markTransactionThrowsAfterCommitRemaining: number,
): string {
  const transportAware = registerFailsRemaining > 0;
  return `
globalThis.__registerFailsRemaining = ${String(registerFailsRemaining)};
globalThis.__suppressPutFailsRemaining = ${String(suppressPutFailsRemaining)};
globalThis.__cancelStatePutFailsRemaining = ${String(cancelStatePutFailsRemaining)};
globalThis.__cancelKvDeleteFailsRemaining = ${String(cancelKvDeleteFailsRemaining)};
globalThis.__staleSuppressionReadsRemaining = ${String(staleSuppressionReadsRemaining)};
globalThis.__writerPutFailsRemaining = ${String(writerPutFailsRemaining)};
globalThis.__purgeFailsRemaining = ${String(purgeFailsRemaining)};
globalThis.__markTransactionFailsBeforeCommitRemaining = ${String(markTransactionFailsBeforeCommitRemaining)};
globalThis.__markTransactionThrowsAfterCommitRemaining = ${String(markTransactionThrowsAfterCommitRemaining)};
globalThis.__markTransactionSagaPutObserved = false;
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
function failAppSuppressDelete(kv) {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => kv.put(key, value),
    delete: async (key) => {
      if (globalThis.__cancelKvDeleteFailsRemaining > 0) {
        globalThis.__cancelKvDeleteFailsRemaining -= 1;
        throw new Error("forced App suppress KV delete failure");
      }
      return kv.delete(key);
    },
  };
}
function staleAppSuppressRead(kv) {
  return {
    get: async (key) => {
      if (
        key.startsWith("holdover-write-suppress:app:") &&
        globalThis.__staleSuppressionReadsRemaining > 0
      ) {
        globalThis.__staleSuppressionReadsRemaining -= 1;
        return "1";
      }
      return kv.get(key);
    },
    put: (key, value) => kv.put(key, value),
    delete: (key) => kv.delete(key),
  };
}
function failWriterPut(kv) {
  return {
    get: (key) => kv.get(key),
    delete: (key) => kv.delete(key),
    put: async (key, value) => {
      if (globalThis.__writerPutFailsRemaining > 0) {
        globalThis.__writerPutFailsRemaining -= 1;
        throw new Error("forced assignment writer KV put failure");
      }
      return kv.put(key, value);
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
