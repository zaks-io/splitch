import { OAuthError } from "./oauth-errors";

/**
 * Cloudflare Turnstile siteverify port (ADR-0034 §4).
 *
 * The anonymous-register door is a public, unauthenticated WRITE surface that
 * mints WorkOS users + D1 rows; per-IP rate limiting alone is defeated by IP
 * rotation, so a bot challenge gates it. The token is verified SERVER-SIDE
 * (siteverify), is single-use, and expires in 300s. The contract this file
 * enforces: `assertValid` is called BEFORE any row is written, and a missing or
 * failed token throws `access_denied` — ZERO rows written (fail-loud, the whole
 * point of the control).
 *
 * LOCAL FIXTURE: there is no real Turnstile locally (no secret, no network). The
 * fixture honors a known-good token and single-use semantics in memory; the real
 * adapter (a `fetch` to `siteverify`) swaps in behind the same port. Two adapters,
 * one interface — the deletion test passes.
 */

export interface TurnstilePort {
  /**
   * Reject the request unless `token` is a valid, unspent challenge solution.
   * Throws `access_denied` (no rows written) on a missing/invalid/replayed token.
   */
  assertValid(token: string | undefined, remoteIp: string | undefined): Promise<void>;
}

interface TurnstileSiteverifyResponse {
  success?: boolean;
  "error-codes"?: string[];
}

interface RuntimeTurnstileOptions {
  endpoint?: string;
  fetcher?: typeof fetch;
  fixture: TurnstilePort;
  platformTarget: string | undefined;
  secret: string | undefined;
}

interface CloudflareTurnstileOptions {
  endpoint?: string;
  fetcher?: typeof fetch;
  secret: string;
  timeoutMs?: number;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 5_000;
const LOCAL_TEST_TARGETS = new Set<string | undefined>([undefined, "local", "pr-ci"]);
const HOSTED_TARGETS = new Set<string | undefined>(["shared-preview", "production"]);

/** The fixture's canonical passing token. */
export const FIXTURE_TURNSTILE_TOKEN = "fixture-turnstile-ok";

/**
 * Prefix the fixture treats as a passing solution. Any token starting with this
 * passes (once), so a test that needs MULTIPLE valid registers (e.g. to exercise
 * the rate ceiling, which is checked AFTER Turnstile) can mint distinct passing
 * tokens (`fixture-turnstile-ok-2`, …) without the single-use store rejecting
 * them. A token NOT carrying the prefix is always rejected.
 */
const FIXTURE_PREFIX = FIXTURE_TURNSTILE_TOKEN;

/**
 * Local fixture verifier. Accepts any token with the fixture prefix, and only
 * once per token value (single-use, mirroring real Turnstile) so a replay test
 * can prove the single-use contract without a real edge.
 */
export function makeFixtureTurnstile(): TurnstilePort {
  const spent = new Set<string>();
  return {
    async assertValid(token) {
      if (!token) {
        throw new OAuthError("access_denied", "Turnstile token is required");
      }
      if (!token.startsWith(FIXTURE_PREFIX)) {
        throw new OAuthError("access_denied", "Turnstile verification failed");
      }
      // Single-use: real Turnstile burns a token on first siteverify.
      if (spent.has(token)) {
        throw new OAuthError("access_denied", "Turnstile token has already been used");
      }
      spent.add(token);
    },
  };
}

export function makeRuntimeTurnstile(options: RuntimeTurnstileOptions): TurnstilePort {
  if (LOCAL_TEST_TARGETS.has(options.platformTarget)) {
    return options.fixture;
  }
  if (!HOSTED_TARGETS.has(options.platformTarget)) {
    throw new Error(
      `auth-api: unsupported SPLITCH_PLATFORM_TARGET for Turnstile verifier: ${options.platformTarget}`,
    );
  }
  if (!options.secret) {
    throw new Error("auth-api: TURNSTILE_SECRET is required outside local/test targets");
  }
  return makeCloudflareTurnstile({
    endpoint: options.endpoint,
    fetcher: options.fetcher,
    secret: options.secret,
  });
}

export function makeCloudflareTurnstile(options: CloudflareTurnstileOptions): TurnstilePort {
  return {
    async assertValid(token, remoteIp) {
      if (!token) {
        throw new OAuthError("access_denied", "Turnstile token is required");
      }
      const result = await siteverify(options, token, remoteIp);
      if (result.success !== true) {
        throw new OAuthError("access_denied", "Turnstile verification failed");
      }
    },
  };
}

async function siteverify(
  options: CloudflareTurnstileOptions,
  token: string,
  remoteIp: string | undefined,
): Promise<TurnstileSiteverifyResponse> {
  const response = await postSiteverify(options, token, remoteIp);
  if (!response.ok) {
    throw new OAuthError("access_denied", "Turnstile verification failed");
  }
  try {
    const result = await response.json();
    if (!isSiteverifyResponse(result)) {
      throw new OAuthError("access_denied", "Turnstile verification failed");
    }
    return result;
  } catch {
    throw new OAuthError("access_denied", "Turnstile verification failed");
  }
}

async function postSiteverify(
  options: CloudflareTurnstileOptions,
  token: string,
  remoteIp: string | undefined,
): Promise<Response> {
  try {
    return await (options.fetcher ?? fetch)(options.endpoint ?? SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(siteverifyBody(options.secret, token, remoteIp)),
      signal: timeoutSignal(options.timeoutMs ?? SITEVERIFY_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError("access_denied", "Turnstile verification failed");
  }
}

function siteverifyBody(
  secret: string,
  token: string,
  remoteIp: string | undefined,
): Record<string, string> {
  if (!remoteIp) {
    return { secret, response: token };
  }
  return { secret, response: token, remoteip: remoteIp };
}

function isSiteverifyResponse(value: unknown): value is TurnstileSiteverifyResponse {
  return typeof value === "object" && value !== null;
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const timeout = (AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal })
    .timeout;
  if (timeout) {
    return timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
