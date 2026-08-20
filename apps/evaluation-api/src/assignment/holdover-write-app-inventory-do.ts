import { DurableObject } from "cloudflare:workers";
import type { AssignmentKv } from "./assignment-store";
import {
  parseAppIdBody,
  parseDeletionBody,
  parseMarkD1Body,
} from "./holdover-write-app-deletion-input";
import type { HoldoverWriteAppInventoryNamespace } from "./holdover-write-app-inventory";
import { handleHoldoverWriteAppInventoryFetch } from "./holdover-write-app-inventory-fetch";
import {
  checkpointAppDeletionCancelStep,
  checkpointAppDeletionFinalizeStep,
  markAppDeletionSagaD1Deleted,
  planAppDeletionCancelStep,
  planAppDeletionFinalizeStep,
  prepareAppDeletionSaga,
  readAppDeletionSaga,
} from "./holdover-write-app-deletion-saga";
import type { HoldoverWriteOutboxNamespace } from "./holdover-write-outbox";
import {
  purgeAppDeletionEntityOutbox,
  resumeAppDeletionEntityAlarms,
} from "./holdover-write-app-inventory-entity-port";

export interface HoldoverWriteAppInventoryEnv {
  ASSIGNMENTS_KV: AssignmentKv;
  HOLDOVER_WRITE_OUTBOX?: HoldoverWriteOutboxNamespace;
  HOLDOVER_WRITE_APP_INVENTORY?: HoldoverWriteAppInventoryNamespace;
}

const SAGA_RETRY_DELAY_MS = 1_000;

/**
 * One Durable Object per App: indexes Entity holdover-write outboxes and owns
 * the durable App deletion saga (prepare → finalize / cancel). Storage
 * transitions serialize under short critical sections; child Entity DO calls
 * run outside them so Entity → App registration cannot form a two-DO cycle.
 */
export class HoldoverWriteAppInventoryDurableObject extends DurableObject<HoldoverWriteAppInventoryEnv> {
  private sagaSection = Promise.resolve();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/cancel-deletion") {
      return this.cancelDeletion(request);
    }
    if (request.method === "POST" && url.pathname === "/finalize-deletion") {
      return this.finalizeDeletion(request);
    }
    return this.serialized(() => this.handleFetch(request));
  }

  override async alarm(): Promise<void> {
    await this.handleAlarm();
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/begin-deletion") {
      return this.beginDeletion(request);
    }
    if (request.method === "POST" && url.pathname === "/mark-d1-deleted") {
      return this.markD1Deleted(request);
    }
    return handleHoldoverWriteAppInventoryFetch(this.ctx.storage, request);
  }

  private async handleAlarm(): Promise<void> {
    const saga = await this.serialized(() => readAppDeletionSaga(this.ctx.storage));
    if (saga === null) return;
    if (saga.phase === "preparing" || saga.phase === "canceling") {
      await this.advanceCancel(saga.appId);
      return;
    }
    if (saga.phase === "d1_deleted" || saga.phase === "finalizing") {
      await this.advanceFinalize(saga.appId, saga.generationId);
      return;
    }
    await this.serialized(() => this.ctx.storage.deleteAlarm());
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
        parsed.generationId,
        parsed.deleteBeforeTsMs,
        null,
      );
      const saga = await readAppDeletionSaga(this.ctx.storage);
      if (saga?.phase !== "canceling" && saga?.phase !== "preparing") {
        await this.ctx.storage.deleteAlarm();
      }
      return Response.json({
        suppressed: true,
        generationId: saga?.generationId ?? parsed.generationId,
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
    try {
      const result = await this.advanceCancel(parsed.appId, parsed.generationId);
      return Response.json({
        cancelled: result.cancelled,
        done: result.done,
        entities: result.entities,
        sagaPhase: result.sagaPhase,
      });
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
      const retryAt = Date.now() + SAGA_RETRY_DELAY_MS;
      const saga = await this.ctx.storage.transaction(async (transaction) => {
        const next = await markAppDeletionSagaD1Deleted(
          transaction,
          parsed.appId,
          parsed.generationId,
          parsed.deleteBeforeTsMs,
        );
        await (next.phase === "completed"
          ? transaction.deleteAlarm()
          : transaction.setAlarm(retryAt));
        return next;
      });
      return Response.json(saga);
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private async finalizeDeletion(request: Request): Promise<Response> {
    const parsed = await parseMarkD1Body(request);
    if (!parsed.ok) return parsed.response;
    try {
      const result = await this.advanceFinalize(
        parsed.appId,
        parsed.generationId,
        parsed.deleteBeforeTsMs,
      );
      return Response.json(result);
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private async advanceCancel(appId: string, generationId?: string) {
    const plan = await this.serialized(async () => {
      await this.armRetry();
      return planAppDeletionCancelStep(
        this.ctx.storage,
        this.env.ASSIGNMENTS_KV,
        appId,
        generationId,
      );
    });
    const step = plan.step;
    if (step) {
      await resumeAppDeletionEntityAlarms(this.env.HOLDOVER_WRITE_OUTBOX, step);
      await this.serialized(() => checkpointAppDeletionCancelStep(this.ctx.storage, step));
    }
    return this.serialized(async () => {
      const saga = await readAppDeletionSaga(this.ctx.storage);
      const done = !plan.cancelled ? plan.done : saga === null;
      if (saga === null && plan.cancelled) await this.ctx.storage.deleteAlarm();
      return {
        done,
        cancelled: plan.cancelled,
        entities: saga?.cancelResumePending ?? [],
        sagaPhase: saga?.phase ?? null,
      };
    });
  }

  private async advanceFinalize(
    appId: string,
    generationId: string | null,
    deleteBeforeTsMs?: number,
  ): Promise<{ readonly done: boolean }> {
    const plan = await this.serialized(async () => {
      await this.armRetry();
      return planAppDeletionFinalizeStep(this.ctx.storage, appId, generationId, deleteBeforeTsMs);
    });
    if (!plan.done) {
      await purgeAppDeletionEntityOutbox(this.env.HOLDOVER_WRITE_OUTBOX, plan.step);
      await this.serialized(() => checkpointAppDeletionFinalizeStep(this.ctx.storage, plan.step));
    }
    const completed = await this.serialized(async () => {
      const saga = await readAppDeletionSaga(this.ctx.storage);
      const done = saga?.phase === "completed";
      if (done) await this.ctx.storage.deleteAlarm();
      return done;
    });
    return { done: completed };
  }

  private armRetry(): Promise<void> {
    return this.ctx.storage.setAlarm(Date.now() + SAGA_RETRY_DELAY_MS);
  }

  private async serialized<T>(closure: () => Promise<T>): Promise<T> {
    const prior = this.sagaSection;
    let release: () => void = () => undefined;
    this.sagaSection = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await closure();
    } finally {
      release();
    }
  }
}
