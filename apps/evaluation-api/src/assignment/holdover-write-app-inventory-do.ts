import { DurableObject } from "cloudflare:workers";
import type { AssignmentKv } from "./assignment-store";
import {
  beginAppInventoryDeletion,
  cancelAppInventoryDeletion,
} from "./holdover-write-app-inventory";
import { handleHoldoverWriteAppInventoryFetch } from "./holdover-write-app-inventory-fetch";
import { appHoldoverWriteSuppressKey } from "./holdover-write-outbox-core";

export interface HoldoverWriteAppInventoryEnv {
  ASSIGNMENTS_KV: AssignmentKv;
}

/**
 * One Durable Object per App: indexes Entity holdover-write outboxes and
 * coordinates two-phase App deletion (prepare → finalize / cancel) under
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
    if (request.method === "POST" && url.pathname === "/cancel-deletion") {
      return this.cancelDeletion(request);
    }
    return handleHoldoverWriteAppInventoryFetch(this.ctx.storage, request);
  }

  private async beginDeletion(request: Request): Promise<Response> {
    const parsed = await parseDeletionBody(request);
    if (!parsed.ok) return parsed.response;
    try {
      const result = await beginAppInventoryDeletion(this.ctx.storage, parsed.deleteBeforeTsMs);
      await this.env.ASSIGNMENTS_KV.put(appHoldoverWriteSuppressKey(parsed.appId), "1");
      return Response.json(result);
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
  }

  private async cancelDeletion(request: Request): Promise<Response> {
    const parsed = await parseCancelBody(request, this.ctx.id.name);
    if (!parsed.ok) return parsed.response;
    try {
      const result = await cancelAppInventoryDeletion(this.ctx.storage);
      if (result.cancelled) {
        const deleteKey = this.env.ASSIGNMENTS_KV.delete?.bind(this.env.ASSIGNMENTS_KV);
        if (!deleteKey) {
          throw new Error("ASSIGNMENTS_KV.delete is required to cancel App holdover suppress");
        }
        await deleteKey(appHoldoverWriteSuppressKey(parsed.appId));
      }
      return Response.json(result);
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : String(cause) },
        { status: 400 },
      );
    }
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

async function parseCancelBody(
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
