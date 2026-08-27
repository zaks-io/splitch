import {
  CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS,
  CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS,
  clientKeyRateLimitTokensPerRequest,
  type RateLimitClass,
  resolveClientKeyRateLimitRps,
} from "@splitch/contracts";
import type { Principal, RateLimitDecision, RateLimiter } from "@splitch/worker-runtime";

export const EVALUATION_RATE_LIMIT_PERIOD_SECONDS = CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS;
export const EVALUATION_RATE_LIMIT_BINDING_LIMIT = CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS;
export const EVALUATION_RATE_LIMIT_RETRY_AFTER_MS = EVALUATION_RATE_LIMIT_PERIOD_SECONDS * 1000;

const DATA_PLANE_RATE_LIMIT_CLASSES = new Set<Exclude<RateLimitClass, "none">>([
  "api-key",
  "client-key",
]);

const configuredRpsByRequest = new WeakMap<Request, number>();

export type EvaluationRateLimitBinding = Pick<RateLimit, "limit">;

/**
 * Remember the cached per-credential cap after auth. The guard calls the
 * limiter next; a missing value on a data-plane class fails closed.
 */
export function rememberCredentialRateLimitRps(
  request: Request,
  rateLimitRps: number | null | undefined,
): void {
  configuredRpsByRequest.set(request, resolveClientKeyRateLimitRps(rateLimitRps));
}

export function evaluationRateLimitIncrement(rps: number): number {
  return clientKeyRateLimitTokensPerRequest(rps);
}

export function evaluationRateLimitKey(
  principal: Principal,
  rateLimitClass: Exclude<RateLimitClass, "none">,
): string {
  const hash = credentialHashFromPrincipalId(principal.id);
  if (hash === null) {
    throw new Error("evaluation-api: rate limiter missing credential hash");
  }
  return `${hash}:${rateLimitClass}`;
}

export function makeEvaluationRateLimiter(
  binding: EvaluationRateLimitBinding | RateLimit | undefined,
): RateLimiter {
  return async ({ class: rateLimitClass, request, principal }) => {
    if (rateLimitClass === "control-plane-actor") {
      // Control Plane already applied the actor limiter before the hop (SPL-449).
      return { limited: false };
    }
    requireDataPlaneRateLimitClass(rateLimitClass);
    if (!binding) {
      throw new Error("evaluation-api: evaluation rate-limit binding is not configured");
    }

    const configuredRps = configuredRpsByRequest.get(request);
    if (configuredRps === undefined) {
      throw new Error("evaluation-api: credential rate-limit state is missing");
    }
    return debitEvaluationRateLimit(
      binding,
      evaluationRateLimitKey(principal, rateLimitClass),
      evaluationRateLimitIncrement(configuredRps),
    );
  };
}

function requireDataPlaneRateLimitClass(
  rateLimitClass: Exclude<RateLimitClass, "none">,
): asserts rateLimitClass is "api-key" | "client-key" {
  if (!DATA_PLANE_RATE_LIMIT_CLASSES.has(rateLimitClass)) {
    throw new Error(`evaluation-api: unsupported rate-limit class ${rateLimitClass}`);
  }
}

async function debitEvaluationRateLimit(
  binding: EvaluationRateLimitBinding,
  key: string,
  debit: number,
): Promise<RateLimitDecision> {
  for (let spent = 0; spent < debit; spent += 1) {
    const { success } = await binding.limit({ key });
    if (!success) {
      return limited();
    }
  }
  return allowed();
}

function allowed(): RateLimitDecision {
  return { limited: false };
}

function limited(): RateLimitDecision {
  return { limited: true, retryAfterMs: EVALUATION_RATE_LIMIT_RETRY_AFTER_MS };
}

function credentialHashFromPrincipalId(id: string): string | null {
  const match = /^(?:client_key|api_key):([0-9a-f]{64})$/u.exec(id);
  return match?.[1] ?? null;
}
