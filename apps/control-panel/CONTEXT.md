# Control Panel context

Read this when touching `apps/control-panel`, frontend specs, or UI copy for authoring flows.

## Owns

- Human-facing wording for control-plane concepts.
- URL and navigation scope language.
- Review, Confirmation, and Promotion UI labels.

## Terms to use in UI

- Use Organization for account ownership.
- Use App for product or service surface.
- Use Environment for `dev`, `prod`, and other deployment contexts.
- Use Flag Configuration for the per-Environment editable state of a Flag.
- Use Promote for moving configuration across Environments.
- Use Start and End for Experiment Run lifecycle.
- Use Approval Request for the pending-change object.
- Use Review for approving or declining an Approval Request.
- Use Confirmation for self-review under a `confirm` Policy.
- Use Client Key for public client-side SDK keys.
- Use API Key for secret server-side SDK keys.

## Navigation scope

Control-panel URLs include `/{orgSlug}/{appSlug}/{env}/...` for readability. Slugs are URL-only.
Resolve them to IDs at the edge. Below routing, code and data speak IDs.

The UI should make App and Environment scope visible. There is no hidden global selected App or hidden
global selected Environment.

## Avoid

- Do not label Organization as workspace, tenant, account, or project.
- Do not label App as workspace, site, tenant, or account.
- Do not use publish for Promotion or Experiment Run lifecycle.
- Do not imply Client Key is secret.
- Do not expose Targeting Rules or full flag config through client-side SDK language.

## Related context

- Control-plane terms: [`../control-plane-api/CONTEXT.md`](../control-plane-api/CONTEXT.md)
- Flag and Experiment terms: [`../evaluation-api/CONTEXT.md`](../evaluation-api/CONTEXT.md)
- UI package wording: [`../../packages/ui/CONTEXT.md`](../../packages/ui/CONTEXT.md)
