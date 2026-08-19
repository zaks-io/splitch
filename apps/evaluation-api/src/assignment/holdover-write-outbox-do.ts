import { DurableObject } from "cloudflare:workers";
import {
  appSuppressionFromKv,
  assignmentWriterPutPort,
  type HoldoverWriteOutboxEnv,
} from "./holdover-write-outbox";
import { runHoldoverWriteAlarm } from "./holdover-write-outbox-core";
import { handleHoldoverWriteOutboxFetch } from "./holdover-write-outbox-fetch";

/**
 * Durably owns Assignment Store holdover writes after Exposure Ticket
 * redemption so an `accepted` ack can never discard work that still needs a
 * KV-complete `putHashed` (SPL-346).
 *
 * All fetch/alarm work runs under `blockConcurrencyWhile` so Entity deletion
 * `/delete` cannot return while an in-flight put is still unresolved.
 */
export class HoldoverWriteOutboxDurableObject extends DurableObject<HoldoverWriteOutboxEnv> {
  override async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.handleFetch(request));
  }

  override async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.handleAlarm());
  }

  private async handleFetch(request: Request): Promise<Response> {
    const putPort = assignmentWriterPutPort(this.env.ASSIGNMENT_STORE_WRITER);
    return handleHoldoverWriteOutboxFetch(
      this.ctx.storage,
      putPort,
      request,
      console,
      Date.now(),
      appSuppressionFromKv(this.env.ASSIGNMENTS_KV),
    );
  }

  private async handleAlarm(): Promise<void> {
    const putPort = assignmentWriterPutPort(this.env.ASSIGNMENT_STORE_WRITER);
    await runHoldoverWriteAlarm(
      this.ctx.storage,
      putPort,
      Date.now(),
      console,
      appSuppressionFromKv(this.env.ASSIGNMENTS_KV),
    );
  }
}
