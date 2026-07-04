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

      it("scrubs Axiom structured logs before ingest", () => {
        const captured: Record<string, unknown>[][] = [];
        const emitter = createSurfaceEmitter(surface.id)({
          onAxiomEvents: (events) => {
            captured.push(events);
          },
        });

        emitter.log("info", `request for ${CANARY_TARGETING_KEY}`, plantedPayload());

        expect(captured.length).toBe(1);
        assertNoCanaryLeak(JSON.stringify(captured));
      });
    });
  }
});

describe("negative proof: bypassing the scrubber leaks canaries", () => {
  it("fails when targeting.email is emitted without scrubbing", () => {
    const leaked = JSON.stringify({ targeting: { email: CANARY_EMAIL } });
    expect(() => assertNoCanaryLeak(leaked)).toThrow();
  });
});
