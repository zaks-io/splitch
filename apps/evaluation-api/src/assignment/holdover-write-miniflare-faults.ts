/** Test-only fault hooks injected around the production Miniflare worker. */

export function holdoverWriteFaultHooks(
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
  if (
    registerFailsRemaining <= 0 &&
    suppressPutFailsRemaining <= 0 &&
    cancelStatePutFailsRemaining <= 0 &&
    cancelKvDeleteFailsRemaining <= 0 &&
    staleSuppressionReadsRemaining <= 0 &&
    writerPutFailsRemaining <= 0 &&
    purgeFailsRemaining <= 0 &&
    markTransactionFailsBeforeCommitRemaining <= 0 &&
    markTransactionThrowsAfterCommitRemaining <= 0
  ) {
    return "";
  }
  return `
const __prodInventoryFetch = HoldoverWriteAppInventoryDurableObject.prototype.fetch;
HoldoverWriteAppInventoryDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm-status" && request.method === "GET") {
    return Response.json({ alarm: await this.ctx.storage.getAlarm(), nowMs: Date.now() });
  }
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    await this.ctx.storage.deleteAlarm();
    if (globalThis.__purgeFailsOnManualAlarm > 0) {
      globalThis.__purgeFailsRemaining = globalThis.__purgeFailsOnManualAlarm;
      globalThis.__purgeFailsOnManualAlarm = 0;
    }
    try {
      await this.handleAlarm();
      return Response.json({ ok: true });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 503 },
      );
    }
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
  const originalStorageTransaction = this.ctx.storage.transaction.bind(this.ctx.storage);
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
  if (
    url.pathname === "/mark-d1-deleted" &&
    (globalThis.__markTransactionFailsBeforeCommitRemaining > 0 ||
      globalThis.__markTransactionThrowsAfterCommitRemaining > 0)
  ) {
    this.ctx.storage.transaction = async (closure) => {
      if (globalThis.__markTransactionFailsBeforeCommitRemaining > 0) {
        globalThis.__markTransactionFailsBeforeCommitRemaining -= 1;
        throw new Error("forced mark transaction failure before commit");
      }
      const result = await originalStorageTransaction(closure);
      if (globalThis.__markTransactionThrowsAfterCommitRemaining > 0) {
        globalThis.__markTransactionThrowsAfterCommitRemaining -= 1;
        throw new Error("forced lost mark transaction response");
      }
      return result;
    };
  }
  if (url.pathname === "/cancel-deletion" && globalThis.__cancelKvDeleteFailsRemaining > 0) {
    this.env.ASSIGNMENTS_KV = failAppSuppressDelete(originalKv);
  }
  try {
    return await __prodInventoryFetch.call(this, request);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
    this.ctx.storage.put = originalStoragePut;
    this.ctx.storage.transaction = originalStorageTransaction;
  }
};
const __prodOutboxFetch = HoldoverWriteOutboxDurableObject.prototype.fetch;
HoldoverWriteOutboxDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm-status" && request.method === "GET") {
    return Response.json({ alarm: await this.ctx.storage.getAlarm(), nowMs: Date.now() });
  }
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    await this.alarm();
    return Response.json({ ok: true });
  }
  if (url.pathname === "/purge" && globalThis.__purgeFailsRemaining > 0) {
    globalThis.__purgeFailsRemaining -= 1;
    return Response.json({ error: "forced Entity purge failure" }, { status: 503 });
  }
  return __prodOutboxFetch.call(this, request);
};
const __prodOutboxAlarm = HoldoverWriteOutboxDurableObject.prototype.alarm;
HoldoverWriteOutboxDurableObject.prototype.alarm = async function () {
  const originalKv = this.env.ASSIGNMENTS_KV;
  this.env.ASSIGNMENTS_KV = staleAppSuppressRead(originalKv);
  try {
    return await __prodOutboxAlarm.call(this);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
  }
};
const __prodAssignmentWriteThrough = AssignmentStoreWriter.prototype.writeThrough;
AssignmentStoreWriter.prototype.writeThrough = async function (input) {
  const originalKv = this.kv;
  this.kv = failWriterPut(originalKv);
  try {
    return await __prodAssignmentWriteThrough.call(this, input);
  } finally {
    this.kv = originalKv;
  }
};
`;
}
