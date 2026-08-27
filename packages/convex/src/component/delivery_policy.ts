export const DELIVERY_LEASE_MS = 60_000;
export const DELIVERY_PRIVACY_DEADLINE_MS = 86_400_000;

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function deliveryRetryDelay(deliveryId: string, attempt: number): number {
  const delays = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000];
  const base = delays[Math.min(Math.max(attempt - 1, 0), delays.length - 1)] ?? 1_800_000;
  const seed = [...`${deliveryId}:${attempt}`].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return Math.round(base * (0.8 + (seed / 0xffffffff) * 0.4));
}
