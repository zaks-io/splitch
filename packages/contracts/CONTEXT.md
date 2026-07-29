# Contracts context

Read this when touching `packages/contracts`, API schemas, storage schemas, request/response
envelopes, or generated clients.

## Owns

- Canonical schema names.
- Field naming discipline for IDs, slugs, keys, and Variant names.
- Shared object vocabulary used by apps and packages.

## Canonical names

Use these names in contract types, fields, and docs unless a lower-level storage spec explicitly says
otherwise:

- `organization` / `organizationId`
- `app` / `appId`
- `environment` / `environmentKey`
- `flag` / `flagKey`
- `variant` / `variantName`
- `defaultVariant`
- `flagConfiguration`
- `targetingKey`
- `evaluationContext`
- `experiment`
- `entity`
- `assignment`
- `experimentRun` / `runId`
- `exposure`
- `eventDefinition` / `eventDefinitionVersion`
- `metricEvent`
- `metric`
- `dimension`
- `segment`
- `clientKey`
- `apiKey`
- `approvalRequest`
- `review`
- `confirmation`
- `promotion`

## Naming rules

- Use Variant, never Variation, in public contracts. Variation may appear only in a Flagship adapter
  mapping.
- Use Experiment Run in public docs when context is not already experimental. `runId` is acceptable
  as a field name.
- Use Targeting Key for the domain term. `targetingKey` is the field name.
- Use Client Key for public SDK credential contracts.
- Use API Key for secret server-side SDK credential contracts.
- Use Flag Configuration for per-Environment editable flag state.
- Use Event Definition for the App-level schema and Event Definition Version for the immutable
  published schema stamped onto each accepted Metric Event.

## IDs and slugs

- IDs are canonical in code, storage, APIs, and generated clients.
- Slugs exist only for human and agent-readable URLs.
- Router code may accept `orgSlug` and `appSlug`, but lower layers should receive IDs.
- Never key storage or internal lookups on slugs.

## Cross-domain ownership

- Organization and membership language: [`../../apps/auth-api/CONTEXT.md`](../../apps/auth-api/CONTEXT.md)
- Environment and policy language: [`../../apps/control-plane-api/CONTEXT.md`](../../apps/control-plane-api/CONTEXT.md)
- Evaluation language: [`../../apps/evaluation-api/CONTEXT.md`](../../apps/evaluation-api/CONTEXT.md)
- Exposure pipeline language: [`../../apps/event-ingest-api/CONTEXT.md`](../../apps/event-ingest-api/CONTEXT.md)
- Analysis language: [`../../apps/analysis-api/CONTEXT.md`](../../apps/analysis-api/CONTEXT.md)
