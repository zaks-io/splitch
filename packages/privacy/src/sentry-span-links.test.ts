import { describe, expect, it } from "vitest";
import { scrubSentrySpan } from "./sentry-scrubber";

describe("Sentry span links", () => {
  it.each([true, false, undefined])(
    "preserves digit-heavy link identity and sampled=%s without mutating input",
    (sampled) => {
      const span = {
        links: [
          {
            trace_id: "123456789abcdef0123456789abcdef0",
            span_id: "123456789abcdef0",
            ...(sampled === undefined ? {} : { sampled }),
            attributes: {
              "sentry.link.type": "previous_trace",
              "http.response.status_code": 200,
              note: "ordinary private text",
              targetingKey: "customer-secret",
              email: "private@example.com",
              "http.request.header.authorization": "Bearer private-token",
              nested: { note: "ordinary private text" },
            },
            future: { email: "private@example.com" },
          },
        ],
      };
      const original = structuredClone(span);
      const scrubbed = scrubSentrySpan(span);

      expect(scrubbed.links).toEqual([
        {
          trace_id: "123456789abcdef0123456789abcdef0",
          span_id: "123456789abcdef0",
          ...(sampled === undefined ? {} : { sampled }),
          attributes: {
            "sentry.link.type": "previous_trace",
            "http.response.status_code": 200,
            note: "[Redacted]",
            targetingKey: "[Redacted]",
            email: "[Redacted]",
            "http.request.header.authorization": "[Redacted]",
            nested: "[Redacted]",
          },
          future: { email: "[Redacted]" },
        },
      ]);
      expect(span).toEqual(original);
      expect(scrubbed.links).not.toBe(span.links);
      expect(scrubbed.links[0]?.attributes).not.toBe(span.links[0]?.attributes);
    },
  );

  it.each([
    "customer-secret",
    "private@example.com",
    ["previous_trace"],
    { value: "previous_trace" },
  ])("redacts unrecognized sentry.link.type values: %j", (value) => {
    const scrubbed = scrubSentrySpan({ links: [{ attributes: { "sentry.link.type": value } }] });
    expect(scrubbed.links[0]?.attributes["sentry.link.type"]).toBe("[Redacted]");
  });

  it("retains attribute-free links and empty link lists", () => {
    const link = {
      trace_id: "123456789abcdef0123456789abcdef0",
      span_id: "123456789abcdef0",
    };
    expect(scrubSentrySpan({ links: [link] }).links).toEqual([link]);
    expect(scrubSentrySpan({ links: [] }).links).toEqual([]);
  });

  it.each([null, "private@example.com", ["private@example.com", null]])(
    "scrubs malformed links: %j",
    (links) => {
      expect(JSON.stringify(scrubSentrySpan({ links }))).not.toContain("private@example.com");
    },
  );
});
