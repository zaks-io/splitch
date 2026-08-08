/**
 * Golden-leak canary: the load-bearing no-leak proof. We plant canary PII in
 * EVERY channel a Sentry event can hide it and assert NONE of the canary strings
 * survive the scrub before emission. If any canary leaks, this test fails and the
 * redaction gate is broken. Channels covered (each an independently-reproduced
 * leak before the allow-list redesign):
 *   - nested breadcrumb `data` (container + key-name redaction)
 *   - `extra` Evaluation Context
 *   - stringified-JSON exception message
 *   - over-cap stringified Evaluation Context with custom attributes
 *   - JSON with a stray prose brace before it (embedded-json greedy-balance bug)
 *   - BARE interpolation in breadcrumb `message`, exception `value`, top-level
 *     `message` (value-pattern pass)
 *   - `request.data` / `request.cookies` (whole-event traversal, was untraversed)
 *
 * The Targeting Key has no universal shape, so the caller (a Worker) registers it
 * via `extraPatterns` — mirrored here so bare-Targeting-Key interpolation is caught.
 */

import { describe, expect, it } from "vitest";
import type { ScrubOptions } from "./scrubber";
import { scrubSentryEvent, type SentryEventLike } from "./sentry-scrubber";

const CANARY_EMAIL = "canary-leak@example.com";
const CANARY_TARGETING_KEY = "tk-canary-targeting-key";
const CANARY_PHONE = "555-867-5309";
/** Undashed phone-shaped body. The dashed canary above cannot expose a mid-token
 * phone match that starts after `_`; this one can. */
const CANARY_UNDASHED_PHONE = "15551234567";
const CANARY_USER_PREFIXED_UNDASHED = `user_${CANARY_UNDASHED_PHONE}`;
const CANARY_CUSTOM_ATTRIBUTE = "enterprise-secret-plan";

// A Worker registers its Targeting Key value shape so bare interpolation is caught.
const OPTIONS: ScrubOptions = { extraPatterns: [/tk-[a-z0-9-]+/gi] };

function plantedEvent(): SentryEventLike {
  return {
    // Operational fields that must be PRESERVED (allow-listed).
    event_id: "evt_1",
    level: "error",
    tags: { appId: "app_1", orgId: "org_1", role: "admin" },
    // ONLY user.id (operator) is vouched for; email/ip_address/username are
    // end-user PII Sentry auto-populates or setUser attaches.
    user: {
      id: "operator-42",
      email: CANARY_EMAIL,
      ip_address: CANARY_PHONE,
      username: CANARY_TARGETING_KEY,
    },
    transaction: "POST /evaluate",
    // Top-level message with embedded stringified JSON PII.
    message: `boom ${JSON.stringify({ email: CANARY_EMAIL })}`,
    extra: {
      context: { email: CANARY_EMAIL, phone: CANARY_PHONE, plan: "pro" },
      targetingKey: CANARY_TARGETING_KEY,
      requestId: "req-123",
    },
    request: {
      data: { email: CANARY_EMAIL },
      cookies: { sid: CANARY_TARGETING_KEY },
      headers: { "x-forwarded-for": CANARY_PHONE },
    },
    breadcrumbs: {
      values: [
        {
          category: "evaluate",
          // Bare Targeting Key interpolated into a breadcrumb message.
          message: `nudge refetch failed for entity=user id=${CANARY_TARGETING_KEY}`,
          data: { targeting: { userId: CANARY_TARGETING_KEY }, attempt: 2 },
        },
      ],
    },
    exception: {
      values: [
        {
          type: "Error",
          // Bare Targeting Key AND a stray-brace-prefixed JSON context — two leaks.
          value: `assign() failed for ${CANARY_TARGETING_KEY} {oops ${JSON.stringify({
            context: { email: CANARY_EMAIL },
          })}`,
        },
      ],
    },
  };
}

function serializedScrub(): string {
  return JSON.stringify(scrubSentryEvent(plantedEvent(), OPTIONS));
}

describe("golden-leak canary", () => {
  it("redacts every planted canary across every channel before emission", () => {
    const serialized = serializedScrub();
    expect(serialized.includes(CANARY_EMAIL)).toBe(false);
    expect(serialized.includes(CANARY_TARGETING_KEY)).toBe(false);
    expect(serialized.includes(CANARY_PHONE)).toBe(false);
  });

  it("preserves operational context so the error stays reportable", () => {
    const serialized = serializedScrub();
    for (const keep of [
      "evt_1",
      "error",
      "app_1",
      "org_1",
      "operator-42",
      "POST /evaluate",
      "req-123",
      "Error",
    ]) {
      expect(serialized.includes(keep)).toBe(true);
    }
  });

  it("redacts bare interpolation in breadcrumb message, exception value, and top-level message", () => {
    const scrubbed = scrubSentryEvent(plantedEvent(), OPTIONS);
    const crumb = (scrubbed.breadcrumbs as { values: Array<{ message: string; data: unknown }> })
      .values[0];
    const exc = (scrubbed.exception as { values: Array<{ value: string }> }).values[0];

    expect((crumb?.message ?? "").includes(CANARY_TARGETING_KEY)).toBe(false);
    expect((crumb?.data as { targeting: unknown }).targeting).toBe("[Redacted]");
    expect((exc?.value ?? "").includes(CANARY_TARGETING_KEY)).toBe(false);
    expect((exc?.value ?? "").includes(CANARY_EMAIL)).toBe(false);
    expect(String(scrubbed.message).includes(CANARY_EMAIL)).toBe(false);
  });

  it("redacts request data, cookies, and headers (whole-event traversal)", () => {
    const scrubbed = scrubSentryEvent(plantedEvent(), OPTIONS);
    const request = JSON.stringify(scrubbed.request);
    expect(request.includes(CANARY_EMAIL)).toBe(false);
    expect(request.includes(CANARY_TARGETING_KEY)).toBe(false);
    expect(request.includes(CANARY_PHONE)).toBe(false);
  });

  it("keeps user.id but redacts user.email / user.ip_address / user.username", () => {
    const user = scrubSentryEvent(plantedEvent(), OPTIONS).user as Record<string, unknown>;
    expect(user.id).toBe("operator-42");
    expect(user.email).toBe("[Redacted]");
    expect(user.ip_address).toBe("[Redacted]");
    expect(user.username).toBe("[Redacted]");
  });

  it("scrubs JSON that follows a stray prose brace (embedded-json greedy-balance fix)", () => {
    const event: SentryEventLike = {
      extra: { note: `{not json ${JSON.stringify({ email: CANARY_EMAIL })}` },
    };
    const serialized = JSON.stringify(scrubSentryEvent(event, OPTIONS));
    expect(serialized.includes(CANARY_EMAIL)).toBe(false);
  });

  it("redacts over-cap stringified Evaluation Context custom attributes before emission", () => {
    const cohort = "private-cohort-name";
    const payload = JSON.stringify({
      context: {
        plan: CANARY_CUSTOM_ATTRIBUTE,
        cohort,
      },
      padding: "x".repeat(5_000),
    });
    const event: SentryEventLike = {
      exception: {
        values: [{ type: "Error", value: `evaluate failed ${payload}` }],
      },
    };

    expect(payload.length).toBeGreaterThan(4_096);
    const serialized = JSON.stringify(scrubSentryEvent(event, OPTIONS));

    expect(serialized.includes(CANARY_CUSTOM_ATTRIBUTE)).toBe(false);
    expect(serialized.includes(cohort)).toBe(false);
  });

  // Dashed phones hide mid-token matches (separators break the word). An
  // undashed `user_<digits>` token must stay byte-identical — phone matching
  // must not start after `_` — while a bare undashed phone still redacts.
  it("keeps an undashed user_-prefixed token intact and still redacts a bare undashed phone", () => {
    const event: SentryEventLike = {
      message: `lookup failed for ${CANARY_USER_PREFIXED_UNDASHED}`,
      extra: { note: `callback ${CANARY_UNDASHED_PHONE}` },
    };
    const scrubbed = scrubSentryEvent(event, OPTIONS);
    expect(String(scrubbed.message)).toBe(`lookup failed for ${CANARY_USER_PREFIXED_UNDASHED}`);
    expect(JSON.stringify(scrubbed.extra).includes(CANARY_UNDASHED_PHONE)).toBe(false);
  });
});
