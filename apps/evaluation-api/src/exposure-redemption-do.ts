import { DurableObject } from "cloudflare:workers";
import {
  handleExposureRedemptionClaimFetch,
  runExposureRedemptionClaimAlarm,
} from "./exposure-redemption-do-handler";

/**
 * One Durable Object per App + Environment serializes redemption claims so
 * exposureId and ticket-fingerprint ownership move together.
 */
export class ExposureRedemptionClaimDurableObject extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    return handleExposureRedemptionClaimFetch(this.ctx, request);
  }

  override async alarm(): Promise<void> {
    await runExposureRedemptionClaimAlarm(this.ctx.storage);
  }
}
