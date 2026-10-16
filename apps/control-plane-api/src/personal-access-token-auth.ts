import { isPersonalAccessTokenSecret } from "@splitch/contracts";
import {
  type AuthResolver,
  type PersonalAccessTokenResolver,
  PUBLIC_PRINCIPAL,
  type RateLimiter,
  resolvePersonalAccessTokenPrincipal,
  verifyPersonalAccessTokenSecret,
} from "@splitch/worker-runtime";

/** Only exact PAT bearers take this path; every other request keeps its existing resolver. */
export function withPersonalAccessTokenBearer(deps: {
  fallback: AuthResolver;
  store: Pick<KVNamespace, "get">;
  resolve: PersonalAccessTokenResolver;
  rateLimiter: RateLimiter;
  nowMs?: () => number;
}): AuthResolver {
  return async (request) => {
    const authorization = request.headers.get("authorization");
    const secret = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!isPersonalAccessTokenSecret(secret)) return deps.fallback(request);

    const limited = await limitAttempts(deps.rateLimiter, request);
    if (limited) return limited;
    const verified = await verifyPersonalAccessTokenSecret(
      deps.store,
      secret,
      (deps.nowMs ?? Date.now)(),
    );
    if (!verified.ok) {
      return {
        ok: false,
        reason: "UNAUTHORIZED",
        error: { code: "UNAUTHORIZED", message: verified.description, details: {} },
      };
    }
    return resolvePersonalAccessTokenPrincipal(verified.actor, deps.resolve);
  };
}

function rateLimited(retryAfterMs: number) {
  return {
    ok: false as const,
    reason: "UNAUTHORIZED" as const,
    error: {
      code: "RATE_LIMITED" as const,
      message: "rate limit exceeded",
      details: { retryAfterMs },
    },
  };
}

async function limitAttempts(rateLimiter: RateLimiter, request: Request) {
  // This shares the native actor binding, with a distinct address-keyed counter.
  // Missing addresses share one bucket instead of obtaining a fresh allowance.
  try {
    const decision = await rateLimiter({
      class: "control-plane-actor",
      request,
      principal: {
        ...PUBLIC_PRINCIPAL,
        id: `personal-access-token-attempt:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
      },
    });
    return decision.limited ? rateLimited(decision.retryAfterMs) : null;
  } catch {
    return rateLimited(1000);
  }
}
