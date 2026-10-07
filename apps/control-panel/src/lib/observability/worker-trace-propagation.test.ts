import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const PARENT_ID = "0123456789abcdef";
const DSN = "https://public@o123.ingest.sentry.io/1";
const probeOrigin = "https://trace-probe.example.test";

type TraceContext = { trace_id: string; span_id: string; parent_span_id?: string };
type ProbeResult = {
  upstream: TraceContext;
  downstream: TraceContext;
  outbound: { "sentry-trace": string; baggage: string; traceparent: string | null };
};
type CapturedEvent = {
  type?: string;
  message?: string;
  contexts?: { trace?: TraceContext };
};

let mf: Miniflare;
const events: CapturedEvent[] = [];
type RecordedSpan = {
  span_id: string;
  name: string;
  trace_id: string;
  attributes: Record<string, { value: unknown }>;
};
const spans: RecordedSpan[] = [];
const envelopes: string[] = [];

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
      contents: `
        import * as Sentry from "@sentry/cloudflare";
        import { wrapWorkerHandler } from "../../packages/observability/src/worker.ts";
        export default wrapWorkerHandler({
          async fetch(request, env) {
            const active = Sentry.spanToJSON(Sentry.getActiveSpan());
            const context = {
              trace_id: active.trace_id,
              span_id: active.span_id,
              parent_span_id: active.parent_span_id,
            };
            if (env.ROLE === "downstream") {
              Sentry.captureMessage("trace propagation probe");
              const outbound = await fetch("${probeOrigin}/headers?cohort=private-canary&targetingKey=tk-worker-canary");
              return Response.json({ downstream: context, outbound: await outbound.json() });
            }
            const response = await env.DOWNSTREAM.fetch(new Request("https://downstream.test/probe"));
            return Response.json({ upstream: context, ...await response.json() });
          },
        }, { surface: "control-panel" });
      `,
    },
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
  });
  const script = bundle.outputFiles?.[0]?.text;
  if (!script) throw new Error("trace propagation probe did not bundle");

  mf = new Miniflare({
    workers: [
      {
        name: "upstream",
        modules: true,
        script,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          SENTRY_RELEASE: "splitch-control-panel@test",
          SENTRY_DSN: DSN,
          ROLE: "upstream",
          SPLITCH_PLATFORM_TARGET: "test",
        },
        serviceBindings: { DOWNSTREAM: "downstream" },
        outboundService: captureOutbound,
      },
      {
        name: "downstream",
        modules: true,
        script,
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          SENTRY_RELEASE: "splitch-control-panel@test",
          SENTRY_DSN: DSN,
          ROLE: "downstream",
          SPLITCH_PLATFORM_TARGET: "test",
        },
        outboundService: captureOutbound,
      },
    ],
  });
  await mf.ready;
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
});

async function captureOutbound(request: Request): Promise<Response> {
  if (new URL(request.url).origin === probeOrigin) {
    return Response.json({
      "sentry-trace": request.headers.get("sentry-trace"),
      baggage: request.headers.get("baggage"),
      traceparent: request.headers.get("traceparent"),
    });
  }
  if (new URL(request.url).hostname !== "o123.ingest.sentry.io") {
    throw new Error(`unexpected outbound request: ${request.url}`);
  }
  const envelope = await request.text();
  envelopes.push(envelope);
  for (const line of envelope.split("\n").filter(Boolean)) {
    const payload = JSON.parse(line) as CapturedEvent & { items?: RecordedSpan[] };
    if (payload.items) spans.push(...payload.items);
    if (payload.contexts?.trace) events.push(payload);
  }
  return new Response("{}", { status: 200 });
}

describe("Worker distributed tracing in the Workers runtime", () => {
  it("continues the caller trace through a service binding, outbound HTTP and a Sentry event", async () => {
    const response = await mf.dispatchFetch("https://panel.test/probe", {
      headers: {
        "sentry-trace": `${TRACE_ID}-${PARENT_ID}-1`,
        baggage: `sentry-org_id=123,sentry-trace_id=${TRACE_ID},sentry-sampled=true`,
        traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ProbeResult;

    expect(result.upstream.trace_id).toBe(TRACE_ID);
    expect(result.upstream.parent_span_id).toBe(PARENT_ID);
    expect(result.downstream.trace_id).toBe(TRACE_ID);
    expect(result.downstream.parent_span_id).toBe(result.upstream.span_id);
    const [outboundTraceId, outboundSpanId, sampled] = result.outbound["sentry-trace"].split("-");
    expect(outboundTraceId).toBe(TRACE_ID);
    expect(sampled).toBe("1");
    expect(result.outbound.traceparent).toBe(`00-${TRACE_ID}-${outboundSpanId}-01`);
    expect(result.outbound.baggage).toContain("sentry-org_id=123");
    await expect
      .poll(() => spans.some((span) => span.attributes["sentry.op"]?.value === "http.client"), {
        timeout: 5_000,
      })
      .toBe(true);
    const outboundSpan = spans.find(
      (span) => span.attributes["sentry.op"]?.value === "http.client",
    );
    expect(outboundSpan).toMatchObject({ name: "[Redacted]", trace_id: TRACE_ID });
    expect(outboundSpan?.attributes["resource.service.name"]?.value).toBe("splitch-control-panel");
    const root = spans.find((span) => span.span_id === result.downstream.span_id);
    expect(root).toBeDefined();
    for (const span of [root, outboundSpan]) {
      expect(span?.attributes).toMatchObject({
        "sentry.segment.id": { value: result.downstream.span_id },
        "sentry.environment": { value: "test" },
        "sentry.release": { value: "splitch-control-panel@test" },
        "sentry.sdk.name": { value: "sentry.javascript.cloudflare" },
        "sentry.sdk.version": { value: "11.4.0" },
        "sentry.trace_lifecycle": { value: "stream" },
      });
    }
    expect(root?.attributes["sentry.segment.name"]?.value).toBe("GET");
    expect(outboundSpan?.attributes["sentry.segment.name"]?.value).toBe("[Redacted]");
    expect(root?.attributes["sentry.sdk.integrations"]?.value).toContain("SplitchPrivacy");

    expect(JSON.stringify(envelopes)).not.toContain("private-canary");
    expect(JSON.stringify(envelopes)).not.toContain("tk-worker-canary");

    await expect
      .poll(
        () =>
          events.find(
            (event) =>
              event.message === "trace propagation probe" &&
              event.contexts?.trace?.span_id === result.downstream.span_id,
          ),
        { timeout: 5_000 },
      )
      .toMatchObject({
        contexts: { trace: { trace_id: TRACE_ID, span_id: result.downstream.span_id } },
      });
  });

  it("starts a fresh trace for another Sentry organization", async () => {
    const response = await mf.dispatchFetch("https://panel.test/probe", {
      headers: {
        "sentry-trace": `${TRACE_ID}-${PARENT_ID}-1`,
        baggage: `sentry-org_id=456,sentry-trace_id=${TRACE_ID},sentry-sampled=true`,
        traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
      },
    });
    const result = (await response.json()) as ProbeResult;
    expect(result.upstream.trace_id).not.toBe(TRACE_ID);
    expect(result.downstream.trace_id).toBe(result.upstream.trace_id);
    expect(result.outbound.traceparent).toContain(`-${result.upstream.trace_id}-`);
  });
});
