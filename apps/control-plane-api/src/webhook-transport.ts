/**
 * The parts of outbound webhook delivery that are genuinely identical across
 * integrations: the backoff ladder, the retryable/terminal split, and the POST
 * itself.
 *
 * Deliberately NOT a shared "dispatch loop". Convex and Cloudflare drain leased
 * outbox tables (one row per delivery, with Cloudflare additionally confirming
 * an applied version header); Sentry advances a cursor over `flag_change_events`
 * and batches whatever is behind it. Those are different enough that a
 * `{claimDue, finish, buildRequest}` supertype would exist only to be satisfied,
 * not to be used. What all three actually share is this file, and each
 * substitutes a `fetcher` for it in tests.
 */

/**
 * Six attempts spanning ~38 minutes. A receiver down longer than that is an
 * outage the operator has to see, not something to keep hammering.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000] as const;

export function retryDelayMs(attemptCount: number): number {
  return RETRY_DELAYS_MS[Math.min(attemptCount, RETRY_DELAYS_MS.length - 1)] ?? 1_800_000;
}

/**
 * 408/429/5xx only. A 4xx is the receiver rejecting the payload or the
 * signature; retrying it just replays the same rejection until the ladder runs
 * out and buries the real error under attempt noise.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export type WebhookPostResult =
  | { outcome: "delivered"; response: Response }
  | { outcome: "rejected"; status: number; retryable: boolean }
  | { outcome: "transport-failed"; cause: unknown };

export interface WebhookPost {
  url: string;
  body: string;
  headers: Record<string, string>;
  fetcher?: typeof fetch;
}

/**
 * `redirect: "manual"` on purpose: following a redirect would re-POST a
 * signed body to a host that never passed the install-time URL validation,
 * turning a customer-supplied webhook URL into an SSRF primitive.
 */
export async function postWebhook(request: WebhookPost): Promise<WebhookPostResult> {
  let response: Response;
  try {
    response = await (request.fetcher ?? fetch)(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
    });
  } catch (cause) {
    return { outcome: "transport-failed", cause };
  }
  if (response.ok) return { outcome: "delivered", response };
  return {
    outcome: "rejected",
    status: response.status,
    retryable: isRetryableStatus(response.status),
  };
}

export function describeCause(cause: unknown): Record<string, unknown> | string {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message, stack: cause.stack }
    : String(cause);
}
