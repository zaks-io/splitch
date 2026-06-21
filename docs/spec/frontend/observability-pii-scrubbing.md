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

| Hop                          | Mechanism                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| SSR loader → read API        | `traceparent` / `sentry-trace` HTTP header injected by the TanStack Start server handler |
| Client-side fetch → read API | `traceparent` header on every `hc` client request                                        |
| Panel Worker → DO            | Carried internally by the Worker runtime                                                 |

A panel error and its backend cause appear as one trace in Sentry. The read API Workers must
accept and continue the incoming trace context.

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

### What is NOT scrubbed

- `userId` (the splitch user/operator ID — not the customer's end-user ID)
- `appId`, `orgId`, `role` (organizational, not end-user PII)
- Experiment IDs, Flag Keys, Variant names (not PII)

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
