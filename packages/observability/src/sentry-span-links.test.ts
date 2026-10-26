import { expect, it } from "vitest";
import { loadSentry } from "./sentry-module.js";
import { workerSentryOptions } from "./worker.js";

it.each([false, true])("serializes private span-v2 links with malformed=%s", async (malformed) => {
  const Sentry = await loadSentry();
  Sentry.setAsyncLocalStorageAsyncContextStrategy();
  const bodies: string[] = [];
  const links = [1, 0].map((traceFlags) => ({
    context: {
      traceId: malformed ? "private@example.com" : "123456789abcdef0123456789abcdef0",
      spanId: malformed ? "private@example.com" : "123456789abcdef0",
      traceFlags,
    },
    attributes: {
      "sentry.link.type": "previous_trace",
      "http.response.status_code": malformed ? "private@example.com" : 200,
      note: "ordinary private text",
      targetingKey: "customer-secret",
      email: "private@example.com",
      "http.request.header.authorization": "Bearer private-token",
    },
  }));
  const original = structuredClone(links);
  const client = new Sentry.CloudflareClient({
    ...workerSentryOptions(
      { SENTRY_DSN: "https://public@example.invalid/1", SPLITCH_PLATFORM_TARGET: "production" },
      { surface: "event-ingest-api" },
      Sentry,
    ),
    integrations: [],
    stackParser: () => [],
    transport: (options) =>
      Sentry.createTransport(options, async ({ body }) => {
        bodies.push(typeof body === "string" ? body : new TextDecoder().decode(body));
        return { statusCode: 200 };
      }),
  });
  client.init();
  try {
    await Sentry.withScope(async (scope) => {
      scope.setClient(client);
      await Sentry.startSpan({ name: "linked request", op: "http.server", links }, async () => {});
    });
    expect(await client.flush()).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    if (body === undefined) throw new Error("Sentry did not serialize a span envelope");
    const [envelopeHeader, itemHeader, payload] = body
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(envelopeHeader).toBeTypeOf("object");
    expect(itemHeader).toMatchObject({
      type: "span",
      content_type: "application/vnd.sentry.items.span.v2+json",
    });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ name: "linked request", is_segment: true });
    expect(payload.items[0].links).toEqual(
      [true, false].map((sampled) => ({
        trace_id: malformed ? "[Redacted]" : "123456789abcdef0123456789abcdef0",
        span_id: malformed ? "[Redacted]" : "123456789abcdef0",
        sampled,
        attributes: {
          "sentry.link.type": { type: "string", value: "previous_trace" },
          "http.response.status_code": malformed
            ? { type: "string", value: "[Redacted]" }
            : { type: "integer", value: 200 },
          note: { type: "string", value: "[Redacted]" },
          targetingKey: { type: "string", value: "[Redacted]" },
          email: { type: "string", value: "[Redacted]" },
          "http.request.header.authorization": { type: "string", value: "[Redacted]" },
        },
      })),
    );
    expect(links).toEqual(original);
  } finally {
    await client.close();
  }
});
