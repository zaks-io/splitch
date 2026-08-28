import { OAuthError } from "./oauth-errors";

/**
 * Anonymous-register + claim rate ceiling (ADR-0034 §4, auth-doors.md Door B).
 *
 * Two ceilings: a per-IP cap (default 10 / IP / hour) AND a global cap across all
 * IPs (placeholder 10,000 / hour). Fail-loud: a hit throws `too_many_requests`
 * (429); the ceiling is checked BEFORE any write.
 *
 * HONEST SCOPE (H1): the maps below are PER-ISOLATE. A Workers deployment runs
 * many isolates, so this in-Worker counter is NOT a true global ceiling and the
 * per-IP cap is only as global as the isolate that happened to serve the request.
 * The Cloudflare Free rule is also source-IP scoped and only provides a short
 * burst block for `/agent/identity`; it is not an authoritative global bound.
 * The paid cross-IP/global WAF ceiling remains explicit debt in ADR-0034. A
 * precise in-app global ceiling would need a shared atomic counter (a Durable
 * Object or D1). This layer is therefore a coarse per-isolate backstop, not a
 * global guarantee. The window is a fixed counter reset on roll-over.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface RateLimitConfig {
  perIpPerHour: number;
  globalPerHour: number;
}

const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  perIpPerHour: 10,
  globalPerHour: 10_000,
};

export interface RateLimiter {
  /** Count one anon-create attempt from `ip`; throw `too_many_requests` if over a ceiling. */
  assertUnderCeiling(ip: string, nowMs: number): void;
}

interface Window {
  startMs: number;
  count: number;
}

function tick(window: Window | undefined, nowMs: number): Window {
  if (!window || nowMs - window.startMs >= HOUR_MS) {
    return { startMs: nowMs, count: 1 };
  }
  return { startMs: window.startMs, count: window.count + 1 };
}

/**
 * In-memory fixed-window limiter. The global window is checked FIRST (a flood
 * from rotating IPs trips it even when each IP is individually under its cap),
 * then the per-IP window. An over-ceiling check throws WITHOUT recording the
 * attempt, so a blocked caller does not inflate the counter further.
 */
export function makeRateLimiter(config: RateLimitConfig = DEFAULT_RATE_LIMITS): RateLimiter {
  let global: Window | undefined;
  const perIp = new Map<string, Window>();

  return {
    assertUnderCeiling(ip, nowMs) {
      const nextGlobal = tick(global, nowMs);
      if (nextGlobal.count > config.globalPerHour) {
        throw new OAuthError("too_many_requests", "global anonymous-create ceiling reached");
      }
      const nextIp = tick(perIp.get(ip), nowMs);
      if (nextIp.count > config.perIpPerHour) {
        throw new OAuthError("too_many_requests", "per-IP anonymous-create ceiling reached");
      }
      global = nextGlobal;
      perIp.set(ip, nextIp);
    },
  };
}
