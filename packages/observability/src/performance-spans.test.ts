import { describe, expect, it } from "vitest";
import { createPerformanceSpanRecorder } from "./performance-spans.js";
import { loadSentry } from "./sentry-module.js";
import { workerSentryOptions } from "./worker.js";

const env = {
  SENTRY_DSN: "https://public@example.invalid/1",
  SPLITCH_PLATFORM_TARGET: "production",
};

type RecordedSpan = Omit<
  Parameters<NonNullable<import("@sentry/cloudflare").CloudflareOptions["beforeSendSpan"]>>[0],
  "attributes"
> & {
  attributes: Record<string, { value: unknown }>;
};

async function recordSpans(run: () => Promise<void>): Promise<RecordedSpan[]> {
  const Sentry = await loadSentry();
  Sentry.setAsyncLocalStorageAsyncContextStrategy();
  const spans: RecordedSpan[] = [];
  const client = new Sentry.CloudflareClient({
    ...workerSentryOptions(env, { surface: "event-ingest-api" }, Sentry),
    integrations: [],
    stackParser: () => [],
    transport: () => ({
      async send(envelope) {
        for (const [header, payload] of envelope[1]) {
          expect(header.type).not.toBe("transaction");
          if (header.type === "span") spans.push(...(payload as { items: RecordedSpan[] }).items);
        }
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
  client.init();
  try {
    await Sentry.withScope(async (scope) => {
      scope.setClient(client);
      await Sentry.startSpan({ name: "test request", op: "http.server" }, run);
    });
    await client.flush();
    expect(spans.length).toBeGreaterThan(0);
    return spans;
  } finally {
    await client.close();
  }
}

describe("performance span export", () => {
  it("exports nested and concurrent stages with intact trace links and scrubbed attributes", async () => {
    const recorder = createPerformanceSpanRecorder(env);
    const spans = await recordSpans(async () => {
      await recorder.record({ name: "Ingest evaluation commit", op: "function" }, async () => {
        await Promise.all(
          ["identity", "lookup"].map((stage) =>
            recorder.record(
              {
                name: `Ingest ${stage}`,
                op: "rpc.client",
                attributes: { "auth.result": "ok", targetingKey: "private@example.com" },
              },
              async () => {},
            ),
          ),
        );
      });
    });
    const root = spans.find((span) => span.is_segment);
    const parent = spans.find((span) => span.name === "Ingest evaluation commit");
    expect(spans).toHaveLength(4);
    expect(root).toBeDefined();
    expect(parent).toBeDefined();
    expect(root?.attributes["resource.service.name"]?.value).toBe("splitch-event-ingest-api");
    expect(parent?.attributes["resource.service.name"]?.value).toBe("splitch-event-ingest-api");
    expect(parent?.parent_span_id).toBe(root?.span_id);
    for (const stage of ["identity", "lookup"]) {
      const child = spans.find((span) => span.name === `Ingest ${stage}`);
      expect(child).toMatchObject({
        parent_span_id: parent?.span_id,
        trace_id: root?.trace_id,
        attributes: { "auth.result": { value: "ok" }, targetingKey: { value: "[Redacted]" } },
      });
    }
    expect(JSON.stringify(spans)).not.toContain("private@example.com");
  });

  it("exports a finished error span and preserves the original rejection", async () => {
    const fault = new Error("storage unavailable");
    const spans = await recordSpans(async () => {
      await expect(
        createPerformanceSpanRecorder(env).record(
          { name: "Ingest outbox seal", op: "rpc.client" },
          async () => {
            throw fault;
          },
        ),
      ).rejects.toBe(fault);
    });
    const span = spans.find((item) => item.name === "Ingest outbox seal");
    expect(span?.status).toBe("error");
    expect(span?.attributes["sentry.status.message"]?.value).toBe("internal_error");
    expect(span?.end_timestamp).toBeGreaterThanOrEqual(span?.start_timestamp ?? Infinity);
  });
});
