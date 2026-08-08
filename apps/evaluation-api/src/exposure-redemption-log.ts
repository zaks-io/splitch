import { errorCauseChain } from "./error-cause-chain";

export interface ExposureRedemptionLogDetail {
  readonly requestId: string;
  readonly appId: string;
  readonly environmentId: string;
  readonly exposureId: string;
}

/**
 * Operator-facing redemption fault log. Always carries the full cause chain
 * (never the outer constant alone) so acknowledge/confirm/release transport
 * failures remain diagnosable. Reads only Error.message — no tickets or keys.
 */
export function logExposureRedemptionFault(
  logger: { error(message: string, detail: unknown): void } | undefined,
  message: string,
  detail: ExposureRedemptionLogDetail,
  cause: unknown,
): void {
  logger?.error(message, {
    requestId: detail.requestId,
    appId: detail.appId,
    environmentId: detail.environmentId,
    exposureId: detail.exposureId,
    causeChain: errorCauseChain(cause),
  });
}
