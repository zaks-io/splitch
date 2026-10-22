import { close, getActiveSpan, init, spanToJSON, startSpan } from "@sentry/node";
import { afterAll, expect, it } from "vitest";
import { createPerformanceSpanRecorder } from "./performance-spans.js";
import { __setSentryModuleForTests } from "./sentry-module.js";
import { workerSentryOptions } from "./worker.js";

const sentryEnv = { SENTRY_DSN: "https://example@sentry.invalid/1" };

init({
  ...workerSentryOptions(sentryEnv, { surface: "control-plane-api" }, {} as never),
  defaultIntegrations: [],
  transport: () => ({ send: async () => ({}), flush: async () => true }),
});

afterAll(async () => {
  __setSentryModuleForTests(undefined);
  await close();
});

it("matches only automatic D1 spans and keeps the retained parent active for children", async () => {
  // Node and Cloudflare use the same pinned core matcher and stream lifecycle.
  __setSentryModuleForTests({ getActiveSpan, startSpan } as unknown as Parameters<
    typeof __setSentryModuleForTests
  >[0]);
  await startSpan({ name: "GET /template/:id", op: "http.server" }, async (root) => {
    await startSpan(
      {
        name: "SELECT 1",
        op: "db.query",
        attributes: { "sentry.origin": "auto.db.cloudflare.d1" },
      },
      async (d1) => {
        expect(d1.isRecording()).toBe(false);
        expect(getActiveSpan()).toBe(root);
        await startSpan({ name: "child", op: "function" }, async (child) => {
          expect(child.isRecording()).toBe(true);
          expect(spanToJSON(child).parent_span_id).toBe(root.spanContext().spanId);
        });
      },
    );
    await createPerformanceSpanRecorder(sentryEnv).record(
      { name: "custom database operation", op: "db.query" },
      async () => {
        expect(getActiveSpan()?.isRecording()).toBe(true);
      },
    );
    for (const origin of ["auto.faas.cloudflare.durable_object", "auto.db.cloudflare.d1.custom"]) {
      await startSpan(
        { name: "retained", op: "db.query", attributes: { "sentry.origin": origin } },
        async (span) => {
          expect(span.isRecording()).toBe(true);
        },
      );
    }
  });
});
