export const DELIVERY_SEND_CONCURRENCY = 6;
export const DELIVERY_BATCH_SIZE = 25;
export const DELIVERY_SEND_TIMEOUT_MS = 5_000;
export const DELIVERY_LEASE_MS = 30_000;

if (
  Math.ceil(DELIVERY_BATCH_SIZE / DELIVERY_SEND_CONCURRENCY) * DELIVERY_SEND_TIMEOUT_MS >=
  DELIVERY_LEASE_MS
) {
  throw new Error("Integration delivery lease must outlive a full batch of timed sends");
}
