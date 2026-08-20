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
  pauseCancelAfterKvDelete: boolean,
  pauseFinalizeAfterInventoryList: boolean,
  missingSuppressionReadsRemaining: number,
  pauseCancelAlarmAfterSnapshot: boolean,
  pausePreparedAlarmAfterSnapshot: boolean,
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
    markTransactionThrowsAfterCommitRemaining <= 0 &&
    !pauseCancelAfterKvDelete &&
    !pauseFinalizeAfterInventoryList &&
    missingSuppressionReadsRemaining <= 0 &&
    !pauseCancelAlarmAfterSnapshot &&
    !pausePreparedAlarmAfterSnapshot
  ) {
    return "";
  }
  return `
const __prodAdvanceCancel = HoldoverWriteAppInventoryDurableObject.prototype.advanceCancel;
HoldoverWriteAppInventoryDurableObject.prototype.advanceCancel = async function (
  appId,
  generationId,
) {
  if (
    globalThis.__pauseCancelAlarmAfterSnapshot &&
    globalThis.__alarmInvocationActive &&
    !globalThis.__cancelAlarmSnapshotReached
  ) {
    globalThis.__cancelAlarmSnapshotReached = true;
    while (!globalThis.__cancelAlarmSnapshotReleased) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  return __prodAdvanceCancel.call(this, appId, generationId);
};
const __prodClearInertAlarm = HoldoverWriteAppInventoryDurableObject.prototype.clearInertAlarm;
HoldoverWriteAppInventoryDurableObject.prototype.clearInertAlarm = async function (saga) {
  if (
    globalThis.__pausePreparedAlarmAfterSnapshot &&
    globalThis.__alarmInvocationActive &&
    !globalThis.__preparedAlarmSnapshotReached
  ) {
    globalThis.__preparedAlarmSnapshotReached = true;
    while (!globalThis.__preparedAlarmSnapshotReleased) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
  return __prodClearInertAlarm.call(this, saga);
};
const __prodInventoryFetch = HoldoverWriteAppInventoryDurableObject.prototype.fetch;
HoldoverWriteAppInventoryDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm-status" && request.method === "GET") {
    return Response.json({ alarm: await this.ctx.storage.getAlarm(), nowMs: Date.now() });
  }
  if (url.pathname === "/__test/transaction-status" && request.method === "GET") {
    return Response.json({ sagaPutObserved: globalThis.__markTransactionSagaPutObserved });
  }
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    await this.ctx.storage.deleteAlarm();
    globalThis.__alarmInvocationActive = true;
    try {
      await this.handleAlarm();
      return Response.json({ ok: true });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 503 },
      );
    } finally {
      globalThis.__alarmInvocationActive = false;
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
  const originalStorageList = this.ctx.storage.list.bind(this.ctx.storage);
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
        return originalStorageTransaction(async (transaction) => {
          const faultedTransaction = new Proxy(transaction, {
            get(target, property, receiver) {
              if (property === "put") {
                return async (key, value) => {
                  const result = await target.put(key, value);
                  if (key === SAGA_KEY && value?.phase === "d1_deleted") {
                    globalThis.__markTransactionSagaPutObserved = true;
                  }
                  return result;
                };
              }
              if (property === "setAlarm") {
                return async () => {
                  globalThis.__markTransactionFailsBeforeCommitRemaining -= 1;
                  throw new Error("forced transactional setAlarm failure");
                };
              }
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          return closure(faultedTransaction);
        });
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
  if (url.pathname === "/cancel-deletion" && globalThis.__pauseCancelAfterKvDelete) {
    this.env.ASSIGNMENTS_KV = pauseAfterAppSuppressDelete(originalKv);
  }
  if (url.pathname === "/finalize-deletion" && globalThis.__pauseFinalizeAfterInventoryList) {
    this.ctx.storage.list = async (options) => {
      const result = await originalStorageList(options);
      if (options?.prefix === "entity:" && !globalThis.__finalizeInventoryListReached) {
        globalThis.__finalizeInventoryListReached = true;
        await globalThis.__finalizeInventoryListBarrier;
      }
      return result;
    };
  }
  try {
    return await __prodInventoryFetch.call(this, request);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
    this.ctx.storage.put = originalStoragePut;
    this.ctx.storage.list = originalStorageList;
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
    const scheduledAt = await this.ctx.storage.getAlarm();
    const originalDateNow = Date.now;
    if (scheduledAt !== null) Date.now = () => scheduledAt;
    try {
      await this.alarm();
      return Response.json({ ok: true });
    } finally {
      Date.now = originalDateNow;
    }
  }
  if (url.pathname === "/purge" && globalThis.__purgeFailsRemaining > 0) {
    globalThis.__purgeFailsRemaining -= 1;
    return Response.json({ error: "forced Entity purge failure" }, { status: 503 });
  }
  const originalKv = this.env.ASSIGNMENTS_KV;
  if (url.pathname === "/ensure" && globalThis.__missingSuppressionReadsRemaining > 0) {
    this.env.ASSIGNMENTS_KV = missAppSuppressRead(originalKv);
  }
  try {
    return await __prodOutboxFetch.call(this, request);
  } finally {
    this.env.ASSIGNMENTS_KV = originalKv;
  }
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
