# Control Plane SDK context

Read this when touching `packages/control-plane-sdk` or generated/shared control-plane clients.

## Role

The Control Plane SDK is a transport/client package over the Control Plane API. It must preserve
control-plane terminology exactly and should not introduce friendlier aliases.

## Terms to preserve

- Organization, App, Environment.
- Flag, Variant, Flag Configuration.
- Promotion.
- Environment Policy.
- Approval Request, Review, Confirmation.
- Experiment, Experiment Run.
- Metric, Dimension, Segment.
- Client Key, API Key.

## Behavior language

- Normal consumers call typed route groups on `createControlPlaneSdk()` (`flags`, `experiments`, …) backed by Hono `hc<ControlPlaneClientApp>()`.
- MCP and other dynamic tool executors import `@splitch/control-plane-sdk/mcp-operation-adapter` and call `callOperationById(operationId, input)` — operation-id dispatch is internal to that adapter, not the public SDK surface.
- Creating an API Key may return its secret value once.
- Listing or retrieving API Key records must not expose an existing secret value.
- Client Keys are public and may be returned freely.
- Promote moves configuration across Environments.
- Start opens an Experiment Run for measurement.

## Related context

- Control Plane API: [`../../apps/control-plane-api/CONTEXT.md`](../../apps/control-plane-api/CONTEXT.md)
- Contract names: [`../contracts/CONTEXT.md`](../contracts/CONTEXT.md)
- CLI context: [`../../apps/cli/CONTEXT.md`](../../apps/cli/CONTEXT.md)
- MCP context: [`../../apps/mcp-server/CONTEXT.md`](../../apps/mcp-server/CONTEXT.md)
