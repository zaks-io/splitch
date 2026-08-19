import { DurableObject } from "cloudflare:workers";
import type { AssignmentKv } from "./assignment-store";
import { beginAppInventoryDeletion } from "./holdover-write-app-inventory";
import { handleHoldoverWriteAppInventoryFetch } from "./holdover-write-app-inventory-fetch";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";

export interface HoldoverWriteAppInventoryEnv {
  ASSIGNMENTS_KV: AssignmentKv;
}

/**
 * One Durable Object per App: indexes Entity holdover-write outboxes and
 * coordinates App deletion (suppress → drain → complete) under
 * `blockConcurrencyWhile`.
 */
export class HoldoverWriteAppInventoryDurableObject extends DurableObject<HoldoverWriteAppInventoryEnv> {
  override async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handleFetch(request));
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/begin-deletion") {
      return this.beginDeletion(request);
    }
    return handleHoldoverWriteAppInventoryFetch(this.ctx.storage, request);
  }

  private async beginDeletion(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { deleteBeforeTsMs?: unknown }).deleteBeforeTsMs !== "number" ||
      !Number.isFinite((body as { deleteBeforeTsMs: number }).deleteBeforeTsMs)
    ) {
      return Response.json({ error: "deleteBeforeTsMs is required" }, { status: 400 });
    }
    const deleteBeforeTsMs = (body as { deleteBeforeTsMs: number }).deleteBeforeTsMs;
    const appIdFromBody = (body as { appId?: unknown }).appId;
    const appId =
      typeof appIdFromBody === "string" && appIdFromBody.length > 0
        ? appIdFromBody
        : this.ctx.id.name;
    if (typeof appId !== "string" || appId.length === 0) {
      return Response.json(
        { error: "appId is required for App deletion suppress" },
        { status: 400 },
      );
    }
    try {
      const result = await beginAppInventoryDeletion(this.ctx.storage, deleteBeforeTsMs);
      // Same critical section as durable suppress: hot-path KV checks see the
      // App tombstone without an eventually-consistent-only race.
      await this.env.ASSIGNMENTS_KV.put(appHoldoverWriteSuppressKey(appId), "1");
      return Response.json(result);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return Response.json({ error: message }, { status: 400 });
    }
  }
}
