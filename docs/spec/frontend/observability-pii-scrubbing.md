# Sentry + Axiom instrumentation, context propagation, and PII scrubbing rules

## Sentry context: set once at session seam

At session validation (the `cookie → KV → LoaderContext` step), Sentry scope is set for the
entire request (SSR) and hydrated on the client. Every downstream event inherits this context
without per-event tagging:

```
Sentry.setUser({ id: ctx.userId })
Sentry.setTag('appId', appId)      // set after requireAppAccess() succeeds
Sentry.setTag('orgId', ctx.orgId)
Sentry.setTag('role',  membership.role)
```

The `appId` tag is set by the loader after `requireAppAccess` succeeds, not at session parse time
(the session doesn't carry a current app; the URL does).

## Distributed tracing

Trace context propagates across these hops:

| Hop                                    | Mechanism                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Browser → panel server function        | Sentry browser tracing adds `sentry-trace`, `baggage`, and W3C `traceparent` to `/_serverFn/` |
| Panel Worker → Control Plane API       | The service-binding transport explicitly replaces all three headers with the active context   |
| Wrapped Worker → service-binding fetch | Sentry instruments the binding and propagates `sentry-trace` and `baggage`                    |
| Wrapped Worker → outbound HTTP fetch   | Sentry adds all three headers to instrumented outbound fetches                                |

Set `propagateTraceparent: true` in the shared Worker and browser options. Preserve browser
`tracePropagationTargets` restricted to same-origin server functions. Keep the existing sampling rate
of `1` on both SDK and native traces. Worker `strictTraceContinuation` remains enabled, so traces
from a different Sentry organization start a new trace. This check is a telemetry policy, not
authentication: incoming baggage is caller-controlled.

The pinned `@sentry/cloudflare` SDK continues incoming HTTP traces from `sentry-trace` and `baggage`.
It does not continue from `traceparent` alone. W3C propagation enables compatible downstream services
to join the application trace, but does not by itself merge Cloudflare native and Sentry SDK traces.

Error-event `contexts.trace` must preserve structural trace fields, including `trace_id`, `span_id`,
and `parent_span_id`, using the span scrubber's allow-list. Apply the normal scrubber to unknown trace
fields and sibling contexts. Otherwise valid hexadecimal IDs containing digit sequences can be
mistaken for phone numbers and lose their trace association.
Error-event trace attributes use the same strict attribute allow-list as transaction spans.

Current limitations: unwrapped WorkerEntrypoint RPC and Durable Object receivers do not continue SDK
traces. Queue instrumentation records publish and batch-processing spans without carrying trace
context in the message body. Alarms start independent traces; durable causal links require an explicit
persisted contract. These paths must not be described as a complete application trace. Cloudflare
native tracing supplies platform visibility through its separate export.

See [Sentry W3C propagation](https://docs.sentry.io/concepts/otlp/sentry-with-otel/),
[Sentry Cloudflare options](https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/#propagateTraceparent),
and [Cloudflare trace limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

## Evaluation response latency

Cloudflare native invocation duration includes post-response `waitUntil` work. Evaluation pins its
configuration WebSocket this way, so a successful response taking about one second can produce a
native invocation lasting about 31 seconds. Preserve the pin: it keeps configuration invalidation
working across requests.

The evaluation Worker annotates the native root with `sentry.op:function.cloudflare.invocation`.
Sentry's OTLP conversion preserves custom attributes, and its normalization keeps an explicit
`sentry.op` instead of inferring `http.server`. The SDK response root retains `http.server` and
`auto.http.cloudflare`. Both root and child SDK spans receive `resource.service.name` from the
closed Worker vocabulary after privacy scrubbing, with `-shared-preview` on that target.

For response-latency views and alerts, use `span.op:http.server span.origin:auto.http.cloudflare`.
For native traces in Axiom, use `attributes.custom["cloudflare.response.time_to_first_byte_ms"]`.
Keep native invocation duration available for background-work diagnosis. After deploying a change,
confirm the operations, service names and latency queries against newly ingested spans; historical
spans retain their original classification.

Verify starts Flag Configuration loading alongside App identity admission. The request-local
CapturingProvider shares that read with the evaluator. Configuration still subscribes before reading
the authoritative snapshot; Assignment access and the final identity-generation check still follow
successful admission. `Verify flag configuration` and `Verify identity admission` spans expose the
overlap without recording request attributes.

Sources: [Cloudflare custom span attributes](https://developers.cloudflare.com/workers/observability/traces/custom-spans/),
[Cloudflare waitUntil lifetime](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil),
[Sentry OTLP attribute conversion](https://github.com/getsentry/relay/blob/master/relay-spans/src/otel_to_sentry_v2.rs),
and [Sentry operation normalization](https://github.com/getsentry/relay/blob/master/relay-event-normalization/src/eap/mod.rs).

## Expected domain failures: breadcrumb only

403 and 404 responses from loaders or the read API are **not** Sentry error events. They are
normal control flow — capturing them as errors pollutes the signal:

```
// Correct
Sentry.addBreadcrumb({ message: '403 access denied for appId', level: 'info' })

// Wrong — do NOT do this
Sentry.captureException(new Error('403 access denied'))
```

## Root and segment boundary errors: reported as errors

When a Tier 1 or Tier 2 boundary catches an unexpected error:

```
Sentry.captureException(error, {
  tags: { boundary: 'root' | 'segment', route: currentRoute },
})
```

These are real defects. They must page.

## Background refetch failures: debug breadcrumb

```
Sentry.addBreadcrumb({
  message: `nudge refetch failed for entity=${entity} id=${id}`,
  level: 'debug',
  data: { attempt, nextRetryMs },
})
```

A pattern of these (elevated rate in Axiom) signals a degraded read API; individual blips are noise.

## PII scrubbing: targeting and context fields

The **Targeting Key** and **Evaluation Context** attributes carry customer end-user PII (user IDs,
email, custom attributes). These MUST be scrubbed from Sentry payloads before transmission.

This rule applies to every surface that can emit Sentry/Axiom data: frontend boundaries, Control Plane
API Worker, Evaluation Worker, Event Ingest Worker, Analysis Worker, MCP Worker, CLI, SDK test
harnesses, and background jobs. Frontend-only scrubbing is a spec bug.

### Fields to scrub (exact paths in Sentry event payload)

Any Sentry event `extra`, `context`, or stringified data matching these patterns must be redacted:

```
targeting.*          // all fields under a 'targeting' object (e.g. targeting.userId, targeting.email)
context.*            // all fields under a 'context' object (Evaluation Context attributes)
evaluationContext.*  // alternate casing
targetingKey         // the bare Targeting Key value itself, at any level
```

### Implementation

Use Sentry's `beforeSend` hook to scrub:

```
beforeSend(event) {
  scrubFieldPaths(event, [
    /^targeting\./,
    /^context\./,
    /^evaluationContext\./,
    /targetingKey/i,
  ])
  return event
}
```

`scrubFieldPaths` replaces matched field values with `'[Redacted]'` (not deletion — deletion
can break schema validation in Sentry ingest). The function must recurse through `extra`,
`contexts`, `breadcrumbs.values[].data`, and stringified exception messages.

### Sentry v11 collection and streamed spans

Every Sentry init explicitly disables automatic user information, cookies, HTTP headers and
bodies, URL query parameters, AI inputs and outputs, GraphQL documents and variables, database
query data, queue arguments, stack-frame variables, and source context lines. Explicit operator
`setUser({ id })` still works for error events and passes through the existing operator allow-list.

Use `traceLifecycle: "stream"` so a runtime environment variable cannot select the retired
transaction path. `beforeSendSpan` scrubs each root and child span using `name` and `attributes`.
The attribute allow-list retains protocol and performance metadata, including Sentry segment IDs,
environment, release, SDK identity and trace lifecycle. Segment names use string scrubbing and are
redacted on outbound HTTP spans. Unknown attributes are redacted. An outbound `http.client` span's entire `name` is redacted, including URLs whose query
values do not match a PII pattern. Error trace contexts retain Sentry's static `data` shape and
still pass through the same strict attribute scrubber. A privacy event processor rejects
transaction events before Sentry's error-only hook can be bypassed.

`rpcTracePropagationBindings: [/.*/]` preserves RPC propagation across all bindings. All eight
Worker configurations already include `nodejs_compat`, which v11 requires.

See the [Sentry v10 to v11 migration guide](https://docs.sentry.io/platforms/javascript/migration/v10-to-v11/).
After an approved merge and shared-preview deployment, inspect a Worker request with an outbound
fetch in Sentry. Confirm the streamed span name and attributes are scrubbed and the server-side
sensitive-field rule fires on the first applicable real error event. That dashboard verification
and the org's Allow Shared Issues decision remain owner tasks.

### What is NOT scrubbed

- `userId` (the splitch user/operator ID — not the customer's end-user ID)
- `appId`, `orgId`, `role` (organizational, not end-user PII)
- Experiment IDs, Flag Keys, Variant names (not PII)

### Server-side backstop in Sentry

The in-process scrubber above is the control: Entity data must not leave the Worker, and Sentry's
server-side scrubbing only runs after an event has arrived. The backstop exists to catch a scrubber
regression, not to replace the scrubber. It is configured in the Sentry dashboard, not in code, so
this section is its record. Change the dashboard and this section together.

Project `splitch` (org `zaksio`) → Settings → Security & Privacy, set 2026-10-03:

| Setting                         | Value                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Data Scrubber                   | on                                                                                                                      |
| Use Default Scrubbers           | on                                                                                                                      |
| Prevent Storing of IP Addresses | on                                                                                                                      |
| Additional Sensitive Fields     | `targetingKey`, `targeting_key`, `evaluationContext`, `evaluation_context`                                              |
| Safe Fields                     | none                                                                                                                    |
| Advanced Data Scrubbing rule    | Replace, Anything, from `targeting \|\| targetingKey \|\| targeting_key \|\| evaluationContext \|\| evaluation_context` |

Selector notes, from Sentry's advanced data scrubbing docs:

- A bare key name selects that key. Do not use mid-path deep wildcards such as `**.targeting.**`:
  Sentry rejects them, and `**` only reaches fields on Sentry's default PII list anyway.
- The generic `context.*` path from "Fields to scrub" is deliberately not mirrored server-side. A
  server-side `context` selector would also hit unrelated fields; the in-process scrubber owns it.

The org-level "Require Data Scrubber", "Require Using Default Scrubbers", and "Prevent Storing of IP
Addresses" toggles are off because they would apply to every project in the `zaksio` org.

## Cloudflare telemetry export

All eight hosted Splitch Workers export native traces to `axiom-traces` and
`sentry-splitch-traces`, and native logs to `axiom-logs`. Declare these destination names in each
Worker's local, shared-preview, and production Wrangler configuration so a deployment preserves the
routing. Endpoint URLs and authentication headers belong to the account-level Cloudflare destinations;
Worker configuration contains only destination names.

Native Cloudflare telemetry does not pass through the application Sentry scrubber. Set
`observability.redact_query_string: true` on every target to remove query strings from native request
URLs before export. Keep both signals enabled, their existing sampling rate of `1`, and
`persist: false` so Cloudflare does not also retain them.

See [Cloudflare OpenTelemetry export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
and [Worker settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/).

## Axiom structured logs

Axiom receives structured log events (request traces, query patterns, error counts). Rules:

- No raw Targeting Key, `targeting_key_hash`, or Evaluation Context attribute values in log fields
- `app_id` is always included for filtering; it is not PII
- Query patterns logged by Tinybird-proxy endpoints include `app_id` and query duration; no raw
  SQL or result data

## Sources

- [ADR-0032](../../adr/0032-privacy-data-lifecycle-is-an-enforced-product-contract.md)
- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
- [../platform/privacy-data-lifecycle.md](../platform/privacy-data-lifecycle.md)
