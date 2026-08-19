import { DurableObject } from "cloudflare:workers";
import {
  appSuppressionFromKv,
  assignmentWriterPutPort,
  type HoldoverWriteOutboxEnv,
  handleHoldoverWriteOutboxFetch,
} from "./holdover-write-outbox";
import { runHoldoverWriteAlarm } from "./holdover-write-outbox-core";

/**
 * Durably owns Assignment Store holdover writes after Exposure Ticket
 * redemption so an `accepted` ack can never discard work that still needs a
 * KV-complete `putHashed` (SPL-346).
 */
export class HoldoverWriteOutboxDurableObject extends DurableObject<HoldoverWriteOutboxEnv> {
  override async fetch(request: Request): Promise<Response> {
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

  override async alarm(): Promise<void> {
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
