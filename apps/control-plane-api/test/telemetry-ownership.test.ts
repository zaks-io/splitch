import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { loadSentry } from "@splitch/observability/sentry-module";
import { createPerformanceSpanRecorder } from "@splitch/observability/performance-spans";
import { workerSentryOptions, wrapWorkerHandler } from "@splitch/observability/worker";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";

const sentryEnv = { SENTRY_DSN: "https://example@sentry.invalid/1" };

afterEach(() => vi.restoreAllMocks());

function captureEnvelopePosts() {
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toContain("sentry.invalid/api/1/envelope/");
    expect(init?.method).toBe("POST");
    const body = init?.body;
    bodies.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
    return new Response("", { status: 200 });
  });
  return bodies;
}

it("sends no envelopes for an idle control-plane minute cron", async () => {
  const bodies = captureEnvelopePosts();
  const ctx = createExecutionContext();
  await worker.scheduled?.(
    createScheduledController({ cron: "* * * * *" }),
    { ...env, ...sentryEnv },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(bodies).toEqual([]);
});

it("captures a thrown scheduled job error with scheduled traces unsampled", async () => {
  const bodies = captureEnvelopePosts();
  const jobError = new Error("scheduled job failed");
  const handler = wrapWorkerHandler(
    {
      fetch: async () => new Response("ok"),
      scheduled: async () => {
        throw jobError;
      },
    },
    { surface: "control-plane-api" },
  );
  const ctx = createExecutionContext();
  await expect(
    handler.scheduled?.(createScheduledController({ cron: "* * * * *" }), sentryEnv, ctx),
  ).rejects.toThrow(jobError);
  await waitOnExecutionContext(ctx);
  const items = bodies.flatMap((body) =>
    body
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(line)),
  );
  expect(items).toContainEqual(expect.objectContaining({ type: "event" }));
  expect(items).toContainEqual(
    expect.objectContaining({
      exception: expect.objectContaining({
        values: expect.arrayContaining([
          expect.objectContaining({
            type: "Error",
            mechanism: expect.objectContaining({ type: "auto.faas.cloudflare.scheduled" }),
          }),
        ]),
      }),
    }),
  );
  expect(items).not.toContainEqual(expect.objectContaining({ type: "span" }));
});

it("drops automatic D1 spans, retains their children and custom and propagation spans", async () => {
  const Sentry = await loadSentry();
  const options = workerSentryOptions(sentryEnv, { surface: "control-plane-api" }, Sentry);
  const recording: boolean[] = [];
  const parentIds: string[] = [];
  const kept: string[] = [];
  let rootId = "";
  let client: ReturnType<typeof Sentry.getClient>;
  const wrapped = Sentry.withSentry(() => options, {
    async fetch() {
      rootId = Sentry.getActiveSpan()!.spanContext().spanId;
      client = Sentry.getClient();
      Sentry.getClient()!.on("spanEnd", (span) => {
        kept.push(Sentry.spanToJSON(span).name);
      });
      await Sentry.startSpan(
        {
          name: "SELECT 1",
          op: "db.query",
          attributes: { "sentry.origin": "auto.db.cloudflare.d1" },
        },
        async (d1) => {
          recording.push(d1.isRecording());
          await Sentry.startSpan({ name: "D1 child", op: "function" }, async (child) => {
            parentIds.push(Sentry.spanToJSON(child).parent_span_id!);
            recording.push(child.isRecording());
          });
        },
      );
      await createPerformanceSpanRecorder(sentryEnv).record(
        { name: "custom query", op: "db.query" },
        async () => {},
      );
      for (const [name, op, origin] of [
        ["durable object", "rpc", "auto.faas.cloudflare.durable_object"],
        ["RPC", "rpc", "auto.rpc.cloudflare"],
        ["service binding", "http.client", "auto.http.cloudflare"],
      ]) {
        await Sentry.startSpan(
          { name, op, attributes: { "sentry.origin": origin } },
          async (span) => {
            recording.push(span.isRecording());
          },
        );
      }
      return new Response("ok");
    },
  });
  const bodies = captureEnvelopePosts();
  const ctx = createExecutionContext();
  await wrapped.fetch(new Request("https://worker.invalid/test"), sentryEnv, ctx);
  await waitOnExecutionContext(ctx);
  await client!.flush();
  expect(recording).toEqual([false, true, true, true, true]);
  expect(parentIds).toEqual([rootId]);
  expect(kept).toEqual(
    expect.arrayContaining([
      "D1 child",
      "custom query",
      "durable object",
      "RPC",
      "service binding",
    ]),
  );
  expect(kept).not.toContain("SELECT 1");
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies)
    for (const line of body.split("\n")) expect(() => JSON.parse(line)).not.toThrow();
});
