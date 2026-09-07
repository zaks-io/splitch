import { describe, expect, it } from "vitest";
import { createPerformanceSpanRecorder } from "./performance-spans.js";
import { loadSentry } from "./sentry-module.js";
import { workerSentryOptions } from "./worker.js";

const env = {
  SENTRY_DSN: "https://public@example.invalid/1",
  SPLITCH_PLATFORM_TARGET: "production",
};

interface RecordedSpan {
  description: string;
  span_id: string;
  parent_span_id: string;
  trace_id: string;
  timestamp: number;
  start_timestamp: number;
  status: string;
  data: Record<string, unknown>;
}

interface RecordedTransaction {
  contexts: { trace: { trace_id: string; span_id: string } };
  spans: RecordedSpan[];
}

async function recordTransaction(run: () => Promise<void>): Promise<RecordedTransaction> {
  const Sentry = await loadSentry();
  Sentry.setAsyncLocalStorageAsyncContextStrategy();
  const transactions: RecordedTransaction[] = [];
  const client = new Sentry.CloudflareClient({
    ...workerSentryOptions(env, { surface: "event-ingest-api" }, Sentry),
    integrations: [],
    stackParser: () => [],
    transport: () => ({
      async send(envelope) {
        for (const [header, payload] of envelope[1]) {
          if (header.type === "transaction") transactions.push(payload as RecordedTransaction);
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
    expect(transactions).toHaveLength(1);
    const transaction = transactions[0];
    if (!transaction) throw new Error("Sentry did not export the transaction");
    return transaction;
  } finally {
    await client.close();
  }
}

describe("performance span export", () => {
  it("exports nested and concurrent stages with intact trace links and scrubbed attributes", async () => {
    const recorder = createPerformanceSpanRecorder(env);
    const transaction = await recordTransaction(async () => {
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
    const parent = transaction.spans.find(
      (span) => span.description === "Ingest evaluation commit",
    );
    expect(parent?.parent_span_id).toBe(transaction.contexts.trace.span_id);
    for (const stage of ["identity", "lookup"]) {
      const child = transaction.spans.find((span) => span.description === `Ingest ${stage}`);
      expect(child).toMatchObject({
        parent_span_id: parent?.span_id,
        trace_id: transaction.contexts.trace.trace_id,
        data: { "auth.result": "ok", targetingKey: "[Redacted]" },
      });
    }
    expect(JSON.stringify(transaction)).not.toContain("private@example.com");
  });

  it("exports a finished error span and preserves the original rejection", async () => {
    const fault = new Error("storage unavailable");
    const transaction = await recordTransaction(async () => {
      await expect(
        createPerformanceSpanRecorder(env).record(
          { name: "Ingest outbox seal", op: "rpc.client" },
          async () => {
            throw fault;
          },
        ),
      ).rejects.toBe(fault);
    });
    const span = transaction.spans.find((item) => item.description === "Ingest outbox seal");
    expect(span?.status).toBe("internal_error");
    expect(span?.timestamp).toBeGreaterThanOrEqual(span?.start_timestamp ?? Infinity);
  });
});
