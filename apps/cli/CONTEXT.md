# CLI context

Read this when touching `apps/cli` or user-facing CLI command text.

## Role

The CLI is a control-plane skin over `@splitch/sdk/control-plane`. It does not create new domain
terms or import the private contracts and Control Plane SDK implementation packages directly.
Use the same names as the Control Plane API and contracts.

## Required language

- Organization, App, Environment.
- Flag, Variant, Flag Configuration.
- Promote for Environment-to-Environment configuration movement.
- Start and End for Experiment Run lifecycle.
- Client Key for public client-side SDK credentials.
- API Key for secret server-side SDK credentials.

## Key handling

- The CLI may display and copy Client Keys.
- The CLI may create, revoke, and list API Key records.
- The CLI must not read back or paste an existing API Key value.
- A newly created API Key may be shown once.

## Avoid

- Do not say workspace, tenant, project, or site for Organization/App.
- Do not use publish.
- Do not call Client Keys secrets.
- Do not call API Keys client keys.

## Related context

- Control-plane terms: [`../control-plane-api/CONTEXT.md`](../control-plane-api/CONTEXT.md)
- Published SDK interface: [`../../packages/sdk/CONTEXT.md`](../../packages/sdk/CONTEXT.md)
- Control Plane SDK implementation: [`../../packages/control-plane-sdk/CONTEXT.md`](../../packages/control-plane-sdk/CONTEXT.md)
- Contract names: [`../../packages/contracts/CONTEXT.md`](../../packages/contracts/CONTEXT.md)
