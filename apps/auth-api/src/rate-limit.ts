import { OAuthError } from "./oauth-errors";

/**
 * Anonymous-register + claim rate ceiling (ADR-0034 §4, auth-doors.md Door B).
 *
 * Two ceilings: a per-IP cap (default 10 / IP / hour) AND a global cap across all
 * IPs (default 10,000 / hour). Fail-loud: a hit throws `too_many_requests`
 * (429); the ceiling is checked BEFORE any write.
 *
 * The deployed adapter sends every decision in a scope to one SQLite Durable
 * Object, so all isolates share the same atomic per-IP and global counters. The
 * in-memory adapter below is retained for deterministic unit tests.
 */

const HOUR_MS = 60 * 60 * 1000;
export const MAX_TRACKED_IP_WINDOWS = 10_000;

export interface RateLimitConfig {
  perIpPerHour: number;
  globalPerHour: number;
}

const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  perIpPerHour: 10,
  globalPerHour: 10_000,
};

export interface RateLimiter {
  /** Count one attempt from `ip`; throw `too_many_requests` if over a ceiling. */
  assertUnderCeiling(ip: string, nowMs: number): void | Promise<void>;
}

export interface RateLimitDurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export type RateLimitScope = "anonymous-create" | "device-authorization";

/** All deployed callers in one scope converge on the same authoritative object. */
export function makeDurableRateLimiter(
  namespace: RateLimitDurableObjectNamespace | undefined,
  scope: RateLimitScope,
  config: RateLimitConfig = DEFAULT_RATE_LIMITS,
): RateLimiter {
  return {
    async assertUnderCeiling(ip, nowMs) {
      if (!namespace) throw new Error("AUTH_ABUSE_RATE_LIMIT binding is unavailable");
      const ipDigest = await sha256Hex(ip);
      const stub = namespace.get(namespace.idFromName(scope));
      const response = await stub.fetch("https://auth-abuse-rate-limit.internal/admit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ipDigest, nowMs, config }),
      });
      if (!response.ok) {
        throw new Error(`Auth abuse rate limiter returned HTTP ${response.status}`);
      }
      const decision = parseDecision(await response.json());
      if (decision.allowed) return;
      const label = scope === "anonymous-create" ? "anonymous-create" : "device-authorization";
      throw new OAuthError(
        "too_many_requests",
        `${decision.reason === "global" ? "global" : "per-IP"} ${label} ceiling reached`,
      );
    },
  };
}

type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "global" | "per_ip" };

function parseDecision(value: unknown): RateLimitDecision {
  if (typeof value !== "object" || value === null || !("allowed" in value)) {
    throw new Error("Auth abuse rate limiter returned an invalid decision");
  }
  if (value.allowed === true) return { allowed: true };
  if (
    value.allowed === false &&
    "reason" in value &&
    (value.reason === "global" || value.reason === "per_ip")
  ) {
    return { allowed: false, reason: value.reason };
  }
  throw new Error("Auth abuse rate limiter returned an invalid decision");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function sweepExpired(
  windows: Map<string, Window>,
  lastSweepMs: number | undefined,
  nowMs: number,
): number {
  if (lastSweepMs !== undefined && nowMs - lastSweepMs < HOUR_MS) return lastSweepMs;
  for (const [ip, window] of windows) {
    if (nowMs - window.startMs >= HOUR_MS) windows.delete(ip);
  }
  return nowMs;
}

function touch(windows: Map<string, Window>, ip: string, window: Window): void {
  windows.delete(ip);
  windows.set(ip, window);
}

function setBounded(windows: Map<string, Window>, ip: string, window: Window): void {
  touch(windows, ip, window);
  if (windows.size <= MAX_TRACKED_IP_WINDOWS) return;
  const leastRecentlyUsedIp = windows.keys().next().value;
  if (leastRecentlyUsedIp === undefined)
    throw new Error("rate-limit IP window map is inconsistent");
  windows.delete(leastRecentlyUsedIp);
}

/**
 * In-memory fixed-window limiter. The global window is checked FIRST (a flood
 * from rotating IPs trips it even when each IP is individually under its cap),
 * then the per-IP window. An over-ceiling check throws WITHOUT recording the
 * attempt, so a blocked caller does not inflate the counter further.
 */
export function makeRateLimiter(config: RateLimitConfig = DEFAULT_RATE_LIMITS): RateLimiter {
  let global: Window | undefined;
  let lastExpirySweepMs: number | undefined;
  const perIp = new Map<string, Window>();

  return {
    assertUnderCeiling(ip, nowMs) {
      lastExpirySweepMs = sweepExpired(perIp, lastExpirySweepMs, nowMs);

      const nextGlobal = tick(global, nowMs);
      if (nextGlobal.count > config.globalPerHour) {
        throw new OAuthError("too_many_requests", "global anonymous-create ceiling reached");
      }
      const currentIp = perIp.get(ip);
      const nextIp = tick(currentIp, nowMs);
      if (nextIp.count > config.perIpPerHour) {
        if (currentIp) touch(perIp, ip, currentIp);
        throw new OAuthError("too_many_requests", "per-IP anonymous-create ceiling reached");
      }
      global = nextGlobal;
      setBounded(perIp, ip, nextIp);
    },
  };
}
