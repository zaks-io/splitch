import type { RateLimiter } from "@splitch/worker-runtime";

export const AUDIENCE = "https://cp.splitch.test";
export const ISSUER = "https://auth.splitch.test";
export const NOW_MS = Date.UTC(2026, 6, 2, 12, 0, 0);
export const allowLimiter: RateLimiter = () => ({ limited: false });
