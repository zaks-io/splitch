import { DurableObject } from "cloudflare:workers";
import type { AssignmentKv } from "./assignment-store";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { handleHoldoverWriteAppInventoryFetch } from "./holdover-write-app-inventory-fetch";
import {
  advanceAppDeletionCancelSaga,
  advanceAppDeletionFinalizeSaga,
  beginOrResumeAppDeletionCancelSaga,
  markAppDeletionSagaD1Deleted,
  prepareAppDeletionSaga,
  readAppDeletionSaga,
} from "./holdover-write-app-deletion-saga";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

export interface HoldoverWriteAppInventoryEnv {
  ASSIGNMENTS_KV: AssignmentKv;
  HOLDOVER_WRITE_OUTBOX?: HoldoverWriteOutboxNamespace;
  HOLDOVER_WRITE_APP_INVENTORY?: HoldoverWriteAppInventoryNamespace;
}

const SAGA_RETRY_DELAY_MS = 1_000;

/**
 * One Durable Object per App: indexes Entity holdover-write outboxes and owns
 * the durable App deletion saga (prepare → finalize / cancel) under
 * `blockConcurrencyWhile`, including alarm-driven cancel resume.
 */
export class HoldoverWriteAppInventoryDurableObject extends DurableObject<HoldoverWriteAppInventoryEnv> {
  override async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handleFetch(request));
  }

  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.handleAlarm());
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/begin-deletion") {
      return this.beginDeletion(request);
    }
    if (request.method === "POST" && url.pathname === "/cancel-deletion") {
      return this.cancelDeletion(request);
    }
    if (request.method === "POST" && url.pathname === "/mark-d1-deleted") {
      return this.markD1Deleted(request);
    }
    if (request.method === "POST" && url.pathname === "/advance-cancel") {
      return this.advanceCancel(request);
    }
    return handleHoldoverWriteAppInventoryFetch(this.ctx.storage, request);
  }

  private async handleAlarm(): Promise<void> {
    const saga = await readAppDeletionSaga(this.ctx.storage);
    if (saga === null) return;
    await this.ctx.storage.setAlarm(Date.now() + SAGA_RETRY_DELAY_MS);
    const advanced =
      saga.phase === "preparing" || saga.phase === "canceling"
        ? await beginOrResumeAppDeletionCancelSaga(
            this.ctx.storage,
            this.env.ASSIGNMENTS_KV,
            saga.appId,
            this.resumePort(),
          )
        : saga.phase === "d1_deleted" || saga.phase === "finalizing"
          ? await advanceAppDeletionFinalizeSaga(this.ctx.storage, saga.appId, this.purgePort())
          : { done: true };
    if (advanced.done) await this.ctx.storage.deleteAlarm();
  }

  private async beginDeletion(request: Request): Promise<Response> {
    const parsed = await parseDeletionBody(request);
    if (!parsed.ok) return parsed.response;
    await this.ctx.storage.setAlarm(Date.now() + SAGA_RETRY_DELAY_MS);
    try {
      const result = await prepareAppDeletionSaga(
        this.ctx.storage,
        this.env.ASSIGNMENTS_KV,
        parsed.appId,
        parsed.deleteBeforeTsMs,
        this.resumePort(),
      );
      const saga = await readAppDeletionSaga(this.ctx.storage);
      if (saga?.phase !== "canceling" && saga?.phase !== "preparing") {
        await this.ctx.storage.deleteAlarm();
      }
      return Response.json({
        suppressed: true,
        deletionComplete: result.deletionComplete,
        deleteBeforeTsMs: parsed.deleteBeforeTsMs,
        entities: [],
        sagaPhase: saga?.phase ?? (result.deletionComplete ? "completed" : "prepared"),
      });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private async cancelDeletion(request: Request): Promise<Response> {
    const parsed = await parseAppIdBody(request, this.ctx.id.name);
    if (!parsed.ok) return parsed.response;
    await this.ctx.storage.setAlarm(Date.now() + SAGA_RETRY_DELAY_MS);
    try {
      const result = await beginOrResumeAppDeletionCancelSaga(
        this.ctx.storage,
        this.env.ASSIGNMENTS_KV,
        parsed.appId,
        this.resumePort(),
      );
      if (result.done) await this.ctx.storage.deleteAlarm();
      const saga = await readAppDeletionSaga(this.ctx.storage);
      return Response.json({
        cancelled: result.cancelled,
        done: result.done,
        entities: saga?.cancelResumePending ?? [],
        sagaPhase: saga?.phase ?? null,
      });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private async advanceCancel(request: Request): Promise<Response> {
    const parsed = await parseAppIdBody(request, this.ctx.id.name);
    if (!parsed.ok) return parsed.response;
    await this.ctx.storage.setAlarm(Date.now() + SAGA_RETRY_DELAY_MS);
    try {
      const advanced = await advanceAppDeletionCancelSaga(
        this.ctx.storage,
        this.env.ASSIGNMENTS_KV,
        parsed.appId,
        this.resumePort(),
      );
      if (advanced.done) await this.ctx.storage.deleteAlarm();
      return Response.json({ done: advanced.done });
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private async markD1Deleted(request: Request): Promise<Response> {
    const parsed = await parseMarkD1Body(request);
    if (!parsed.ok) return parsed.response;
    try {
      const saga = await markAppDeletionSagaD1Deleted(
        this.ctx.storage,
        parsed.appId,
        parsed.deleteBeforeTsMs,
      );
      if (saga.phase === "d1_deleted" || saga.phase === "finalizing") {
        await this.ctx.storage.setAlarm(Date.now() + SAGA_RETRY_DELAY_MS);
      }
      return Response.json(saga);
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private resumePort() {
    const namespace = this.env.HOLDOVER_WRITE_OUTBOX;
    if (!namespace) return null;
    return {
      async resumeAlarms(identity: {
        readonly appId: string;
        readonly idType: string;
        readonly targetingKeyHash: string;
      }) {
        const stub = namespace.get(namespace.idFromName(holdoverWriteOutboxName(identity)));
        const response = await stub.fetch("https://holdover-write-outbox.local/resume-alarms", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!response.ok) {
          throw new Error(
            `holdover write outbox /resume-alarms failed: HTTP ${String(response.status)}`,
          );
        }
      },
    };
  }

  private purgePort() {
    const namespace = this.env.HOLDOVER_WRITE_OUTBOX;
    if (!namespace) {
      throw new Error("HOLDOVER_WRITE_OUTBOX is required to finalize App deletion");
    }
    return {
      async purgeEntity(deletion: {
        readonly appId: string;
        readonly idType: string;
        readonly targetingKeyHash: string;
        readonly deleteBeforeTsMs: number;
      }) {
        const stub = namespace.get(namespace.idFromName(holdoverWriteOutboxName(deletion)));
        const response = await stub.fetch("https://holdover-write-outbox.local/purge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deleteBeforeTsMs: deletion.deleteBeforeTsMs }),
        });
        if (!response.ok) {
          throw new Error(`holdover write outbox /purge failed: HTTP ${String(response.status)}`);
        }
      },
    };
  }
}

async function parseDeletionBody(
  request: Request,
): Promise<
  { ok: true; appId: string; deleteBeforeTsMs: number } | { ok: false; response: Response }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: Response.json({ error: "invalid JSON" }, { status: 400 }) };
  }
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { deleteBeforeTsMs?: unknown }).deleteBeforeTsMs !== "number" ||
    !Number.isFinite((body as { deleteBeforeTsMs: number }).deleteBeforeTsMs)
  ) {
    return {
      ok: false,
      response: Response.json({ error: "deleteBeforeTsMs is required" }, { status: 400 }),
    };
  }
  const deleteBeforeTsMs = (body as { deleteBeforeTsMs: number }).deleteBeforeTsMs;
  const appIdFromBody = (body as { appId?: unknown }).appId;
  const appId =
    typeof appIdFromBody === "string" && appIdFromBody.length > 0 ? appIdFromBody : undefined;
  if (appId === undefined) {
    return {
      ok: false,
      response: Response.json(
        { error: "appId is required for App deletion suppress" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, appId, deleteBeforeTsMs };
}

async function parseAppIdBody(
  request: Request,
  doName: string | undefined,
): Promise<{ ok: true; appId: string } | { ok: false; response: Response }> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const appIdFromBody =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { appId?: unknown }).appId === "string"
      ? (body as { appId: string }).appId
      : "";
  const appId = appIdFromBody.length > 0 ? appIdFromBody : doName;
  if (typeof appId !== "string" || appId.length === 0) {
    return {
      ok: false,
      response: Response.json(
        { error: "appId is required to cancel App deletion" },
        { status: 400 },
      ),
    };
  }
  return { ok: true, appId };
}

async function parseMarkD1Body(
  request: Request,
): Promise<
  | { ok: true; appId: string; deleteBeforeTsMs: number | undefined }
  | { ok: false; response: Response }
> {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const appIdFromBody =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { appId?: unknown }).appId === "string"
      ? (body as { appId: string }).appId
      : "";
  if (appIdFromBody.length === 0) {
    return {
      ok: false,
      response: Response.json({ error: "appId is required to mark D1 deletion" }, { status: 400 }),
    };
  }
  const raw =
    typeof body === "object" && body !== null
      ? (body as { deleteBeforeTsMs?: unknown }).deleteBeforeTsMs
      : undefined;
  const deleteBeforeTsMs = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  return { ok: true, appId: appIdFromBody, deleteBeforeTsMs };
}
