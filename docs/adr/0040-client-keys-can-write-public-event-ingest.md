# Client Keys can write public event ingest

**Status:** accepted

Splitch allows public Client Keys to submit Metric Events and Web Events for their App and Environment, in addition to Exposure-bearing `evaluate`. These are write-only data-plane surfaces: they validate identity, origin, rate limits, event schema, and allowlisted dimensions, and they return no config, Targeting Rules, salts, allocation, Variant, or analysis data.

## Considered options

- **API Key only for all event ingest** — rejected because browser and mobile SDKs would need a customer-owned proxy or a separate analytics service before Metric Events or Web Events could work.
- **Client Key event ingest** — accepted because the Client Key is already public, App/Environment-scoped, origin-bound, and rate-limited; the additional surface is write-only and preserves the no-silent-read boundary from ADR-0034.

## Consequences

Client Key abuse controls apply to evaluate, Metric Event ingest, and Web Event ingest. Event ingest must fail closed on malformed identity, disallowed event names, disallowed dimensions, and origin/rate-limit violations.
