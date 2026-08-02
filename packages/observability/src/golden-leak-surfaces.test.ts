import { REDACTED } from "@splitch/privacy";
import { describe, expect, it } from "vitest";
import { createSurfaceEmitter } from "./surface-wiring.js";
import { OBSERVABILITY_SURFACES } from "./surfaces.js";

const CANARY_EMAIL = "canary-leak@example.com";
const CANARY_TARGETING_KEY = "tk-canary-targeting-key";
const CANARY_PHONE = "555-867-5309";

function plantedPayload(): Record<string, unknown> {
  return {
    targeting: { email: CANARY_EMAIL, userId: CANARY_TARGETING_KEY },
    context: { phone: CANARY_PHONE },
    targetingKey: CANARY_TARGETING_KEY,
    message: `failed for ${CANARY_TARGETING_KEY}`,
  };
}

/**
 * Credential shapes this platform actually carries. They need their own canaries
 * because the key-name policy structurally cannot reach them: a fault identity is
 * one flat string filed under a non-PII key, so value-shape patterns are the only
 * thing between a secret interpolated into a throw and Sentry.
 */
const CREDENTIAL_CANARIES = [
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1XzEifQ.sIgNaTuRe",
  "p.eyJ1IjogImFiYyIsICJpZCI6ICJ4eXoifQ",
  // Underscores keep this off gitleaks' Stripe rule while still exercising the
  // `sk_`/`pk_` pattern: a fixture that reads as a live key trips every scanner
  // in the repo forever, and a canary only has to look like the shape we redact.
  "sk_test_NOT_A_REAL_CREDENTIAL_0123",
  "ACCESS_TOKEN_SECRET=hunter2-supersecret-value",
  "authorization: Bearer abcd1234efgh5678ijkl",
  // Host has no dot-TLD, so the email pattern cannot incidentally swallow it.
  "postgres://splitch:S3cretPassw0rd@db-internal:5432/splitch",
] as const;

/**
 * A stack frame with no credential in it. Patterns broad enough to catch secrets
 * are also broad enough to shred the diagnostics the fault field exists to carry,
 * so the scrub has to be provably narrow as well as provably wide.
 */
const DIAGNOSTIC_FAULT = "Error: D1_ERROR: no such table: experiments\n    at repo.ts:42:11";

function faultRow(secret: string): Record<string, unknown> {
  return { fault: `Error: upstream rejected ${secret}\n    at handler (worker.js:1:1)` };
}

function assertNoCanaryLeak(serialized: string): void {
  expect(serialized.includes(CANARY_EMAIL)).toBe(false);
  expect(serialized.includes(CANARY_TARGETING_KEY)).toBe(false);
  expect(serialized.includes(CANARY_PHONE)).toBe(false);
}

describe("golden-leak canary per observability surface", () => {
  for (const surface of OBSERVABILITY_SURFACES) {
    describe(surface.id, () => {
      it("scrubs Sentry payloads before emit", () => {
        const captured: Record<string, unknown>[] = [];
        const emitter = createSurfaceEmitter(surface.id)({
          onSentryEvent: (event) => {
            captured.push(event);
          },
        });

        emitter.captureException(new Error(`boom ${CANARY_EMAIL}`), plantedPayload());

        expect(captured.length).toBeGreaterThan(0);
        assertNoCanaryLeak(JSON.stringify(captured));
        const extra = captured[0]?.extra as Record<string, unknown>;
        expect(extra?.targeting).toBe("[Redacted]");
      });

      it("scrubs structured logs before emit", () => {
        const captured: Record<string, unknown>[][] = [];
        const emitter = createSurfaceEmitter(surface.id)({
          onStructuredLogEvents: (events) => {
            captured.push(events);
          },
        });

        emitter.log("info", `request for ${CANARY_TARGETING_KEY}`, plantedPayload());

        expect(captured.length).toBe(1);
        assertNoCanaryLeak(JSON.stringify(captured));
      });

      it.each(CREDENTIAL_CANARIES)("scrubs %s out of a flattened fault string", (secret) => {
        const captured: Record<string, unknown>[][] = [];
        const emitter = createSurfaceEmitter(surface.id)({
          onStructuredLogEvents: (events) => {
            captured.push(events);
          },
        });

        emitter.log("error", "request_fault", faultRow(secret));

        // `JSON.stringify([])` contains no secret either, so a dropped row would
        // satisfy the assertion below without the scrubber doing anything. Pin
        // the row down first: emitted, and visibly redacted where the secret was.
        expect(captured).toHaveLength(1);
        expect(captured[0]?.[0]?.fault).toContain(REDACTED);
        expect(JSON.stringify(captured)).not.toContain(secret);
      });

      it("leaves a credential-free stack frame intact", () => {
        const captured: Record<string, unknown>[][] = [];
        const emitter = createSurfaceEmitter(surface.id)({
          onStructuredLogEvents: (events) => {
            captured.push(events);
          },
        });

        emitter.log("error", "request_fault", { fault: DIAGNOSTIC_FAULT });

        expect(captured[0]?.[0]?.fault).toBe(DIAGNOSTIC_FAULT);
      });
    });
  }
});

describe("negative proof: bypassing the scrubber leaks canaries", () => {
  it("fails when targeting.email is emitted without scrubbing", () => {
    const leaked = JSON.stringify({ targeting: { email: CANARY_EMAIL } });
    expect(() => assertNoCanaryLeak(leaked)).toThrow();
  });

  // Without this the fault assertions above would pass on a row that never
  // carried the secret in the first place.
  it.each(CREDENTIAL_CANARIES)("carries %s verbatim before scrubbing", (secret) => {
    expect(JSON.stringify(faultRow(secret))).toContain(secret);
  });
});
