export const QUEUE_MAX_RETRIES = 7;

const RETRY_BASE_SECONDS = 5;
const RETRY_MAX_SECONDS = 43_200;

export function queueRetryDelaySeconds(attempts: number, messageId: string): number {
  const attempt = Number.isFinite(attempts)
    ? Math.min(Math.max(Math.trunc(attempts), 1), QUEUE_MAX_RETRIES)
    : 1;
  const base = Math.min(RETRY_BASE_SECONDS * 2 ** (attempt - 1), RETRY_MAX_SECONDS);
  return Math.min(base + Math.floor(base * jitterFraction(messageId)), RETRY_MAX_SECONDS);
}

function jitterFraction(messageId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < messageId.length; index += 1) {
    hash ^= messageId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % 1_000) / 1_000;
}
