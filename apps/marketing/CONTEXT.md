# Marketing context

Read this when touching `apps/marketing` or public product copy.

## Role

Marketing uses the same product language as the rest of splitch but should stay high level. It should
not introduce implementation vocabulary or alternative names.

## Public terms

- Feature flags.
- A/B experimentation.
- App for a product or service surface.
- Environment for dev, prod, and similar deployment contexts.
- Flag and Variant.
- Experiment and Metric.
- Client Key only when explaining client-side SDK setup.
- API Key only when explaining server-side SDK setup.

## Avoid

- Do not use Site, Project, Tenant, Workspace, or Account as product-domain labels.
- Do not say publish when the product action is Promote or Start.
- Do not expose Targeting Rules, salts, or assignment internals in public copy unless a technical doc
  explicitly requires it.
- Do not imply Client Keys are secret.

## Related context

- Root terminology: [`../../CONTEXT.md`](../../CONTEXT.md)
- Control-plane terms: [`../control-plane-api/CONTEXT.md`](../control-plane-api/CONTEXT.md)
- SDK language: [`../../packages/sdk/CONTEXT.md`](../../packages/sdk/CONTEXT.md)
