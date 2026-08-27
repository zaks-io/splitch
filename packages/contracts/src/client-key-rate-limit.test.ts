import { describe, expect, it } from "vitest";
import {
  CLIENT_KEY_RATE_LIMIT_WINDOW_RPS,
  CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS,
  CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS,
  clientKeyRateLimitTokensPerRequest,
  DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS,
  isExactClientKeyRateLimitRps,
  resolveClientKeyRateLimitRps,
} from "./client-key-rate-limit";
import { PatchClientKeyRequestSchema } from "./routes/route-shapes";

describe("client key rate-limit contract", () => {
  it("keeps the ADR 100 rps default as an exact debit of the 3000/10s window", () => {
    expect(DEFAULT_CLIENT_KEY_RATE_LIMIT_RPS).toBe(100);
    expect(CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS / CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS).toBe(
      CLIENT_KEY_RATE_LIMIT_WINDOW_RPS,
    );
    expect(clientKeyRateLimitTokensPerRequest(100)).toBe(3);
    expect(
      CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS /
        CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS /
        clientKeyRateLimitTokensPerRequest(100),
    ).toBe(100);
  });

  it("treats a missing or null rateLimitRps as the ADR 100 rps default", () => {
    expect(resolveClientKeyRateLimitRps(null)).toBe(100);
    expect(resolveClientKeyRateLimitRps(undefined)).toBe(100);
    expect(resolveClientKeyRateLimitRps(25)).toBe(25);
    expect(resolveClientKeyRateLimitRps(30)).toBe(30);
  });

  it("accepts only integers the 3000/10s binding can enforce exactly", () => {
    expect(isExactClientKeyRateLimitRps(30)).toBe(true);
    expect(isExactClientKeyRateLimitRps(25)).toBe(true);
    expect(isExactClientKeyRateLimitRps(7)).toBe(false);
    expect(isExactClientKeyRateLimitRps(80)).toBe(false);
    expect(isExactClientKeyRateLimitRps(300)).toBe(false);
  });

  it("fails loud on a rateLimitRps the Cloudflare limiter cannot enforce exactly", () => {
    expect(() => resolveClientKeyRateLimitRps(0)).toThrow(/enforce exactly/);
    expect(() => resolveClientKeyRateLimitRps(-1)).toThrow(/enforce exactly/);
    expect(() => resolveClientKeyRateLimitRps(1.5)).toThrow(/enforce exactly/);
    expect(() => resolveClientKeyRateLimitRps(7)).toThrow(/enforce exactly/);
    expect(() => resolveClientKeyRateLimitRps(80)).toThrow(/enforce exactly/);
  });

  it("debits an integer token count that yields the stored 30 rps cap exactly", () => {
    expect(clientKeyRateLimitTokensPerRequest(30)).toBe(10);
    expect(
      CLIENT_KEY_RATE_LIMIT_WINDOW_TOKENS /
        CLIENT_KEY_RATE_LIMIT_WINDOW_SECONDS /
        clientKeyRateLimitTokensPerRequest(30),
    ).toBe(30);
  });

  it("accepts exact PATCH overrides and rejects non-enforceable rates", () => {
    expect(PatchClientKeyRequestSchema.safeParse({ rateLimitRps: 30 }).success).toBe(true);
    expect(PatchClientKeyRequestSchema.safeParse({ rateLimitRps: 25 }).success).toBe(true);
    expect(PatchClientKeyRequestSchema.safeParse({ rateLimitRps: 7 }).success).toBe(false);
    expect(PatchClientKeyRequestSchema.safeParse({ rateLimitRps: 80 }).success).toBe(false);
  });
});
