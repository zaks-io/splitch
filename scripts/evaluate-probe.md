# Evaluate latency probe

`node scripts/evaluate-probe.mjs` sends five sequential requests to
`POST https://edge.preview.splitch.dev/api/sdk/evaluate`. It prints each full-response latency,
the Cloudflare Ray IDs, median, nearest-rank p95 and maximum. With only five samples, p95 is the
maximum. The first request remains in the summary so cold-start cost stays visible. The requests
produce the existing native Worker traces. No client tracing SDK or additional telemetry export
is required.

The script fixes the shared-preview endpoint and smoke Flag Key. Each invocation uses one
synthetic Targeting Key and a distinct Idempotency-Key per logical Evaluation. It records
Evaluation usage through the normal endpoint. It never writes Flag Configuration or creates
credentials. Redirects fail rather than forwarding a credential to another endpoint.

## Existing credentials and activation

The hosted smoke setup uses GitHub environment `preview`, not `shared-preview`.
Its `SPLITCH_SMOKE_CLIENT_SECRET` secret authenticates the OAuth smoke identity, not an
Environment Client Key. The dark-launch smoke creates transient Apps and revokes their Client
Keys during cleanup. Those keys cannot support a recurring probe.

The persistent seed in [seed-shared-preview-smoke-sql.mjs](./seed-shared-preview-smoke-sql.mjs)
already supplies a public Client Key for App `app_shared_preview_smoke`, Environment
`env_shared_preview_smoke_dev`, Flag `shared-preview-smoke`.

On 2026-10-22, GitHub's `preview` environment had the OAuth secret but no
`SPLITCH_SMOKE_CLIENT_KEY` secret. To enable the workflow without creating any credential:

1. Set environment `preview` secret `SPLITCH_SMOKE_CLIENT_KEY` to the existing seeded public
   Client Key `pk_shared_preview_smoke_dev`.
2. Set repository variable `SPLITCH_EVALUATE_PROBE_ENABLED` to `true`. Job-level conditions
   cannot read environment-scoped variables before selecting the environment.

The [workflow](../.github/workflows/evaluate-probe.yml) runs hourly at minute 23 or by manual
dispatch, only on `main` and only after that repository opt-in. No secrets or variables are
provisioned by this change. Missing credentials fail loudly. No production job, URL override or
production credential is wired. Production activation requires a separately approved change and
an existing Environment Client Key held in the production GitHub environment.

## Verify latency and KV decisions

Verify records `Verify identity revalidation` through `PerformanceSpanRecorder` around the
trailing identity-version read, including failed revalidation. Existing admission and configuration
prefetch spans remain concurrent.

Evaluation's credential, revocation, Assignment holdover and configuration fallback KV reads use
`getWithMetadata(key, "text")`. Each read has a native `Read credentials KV`,
`Read assignments KV` or `Read configuration KV` span. The pinned Workers types expose
`cacheStatus`. Recognized `hit`, `miss` and `expired` values become `kv.cache_status`; missing,
null or unrecognized values leave duration only. A missing value is never inferred to be a miss.
Native attributes contain no KV keys, values, metadata, credentials or Evaluation Context.
The adapter uses Cloudflare's [custom span `enterSpan` API](https://developers.cloudflare.com/workers/observability/traces/custom-spans/),
which ends each read span when its promise settles, including errors.
The Sentry scrubber would redact this new attribute, so it remains native-only and the allow-list
is unchanged.

Hosted Flag Configuration and identity admission reads use authoritative Config Store DO calls.
Identity reads are not KV reads in hosted environments. Configuration uses KV only to classify an
authoritative-read failure, and never serves it as the current configuration. Local identity KV
reads also use the native read adapter.

No `cacheTtl` is added. [Config store lines 94-105](../docs/spec/platform/config-store.md#five-second-evaluation-propagation-contract)
require authoritative reads after misses or reconnects and fail at five seconds from announcement.
KV's minimum configurable TTL of 30 seconds cannot satisfy that contract for mutable flag keys.
Identity generation must remain current to preserve the reset admission fence. The config-store
spec grants no stale identity window or immutable identity read here. Assignment holdovers have a
separate tolerated window at lines 107-108, but that does not authorize caching flag or identity
reads. Credential revocation reads retain their existing freshness behavior too.

## Evidence and remaining hosted check

A manual run against the existing shared-preview seed on 2026-10-22 completed all five requests.
Latencies were 5755.47, 1118.71, 801.34, 1403.42 and 1030.91 ms. Median was 1118.71 ms and
p95/max was 5755.47 ms. The first Ray ID was `a4eb6a89da106387-LAX`.
These measurements include network time from the sandbox and are a baseline, not a propagation
SLO assertion.

The [native trace for the fifth request](https://zaksio.sentry.io/explore/traces/trace/84ea487e0f298e92cd7eba477923e27b)
has `url.path:/api/sdk/evaluate`, `cloudflare.ray_id:a4eb6ac1df496387` and
`resource.service.name:splitch-evaluation-api-shared-preview`. Its native invocation took
1037 ms and contains 43 spans with no errors. The Ray ID matches the probe's fifth measurement.

This branch has not been deployed. After an owner-approved shared-preview deployment, capture a
verify trace containing the new revalidation span and native `kv.cache_status` on supported
reads. That screenshot or Sentry link remains required hosted acceptance evidence. No production
probe or workflow dispatch has run for this change.
