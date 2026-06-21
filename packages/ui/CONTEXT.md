# UI package context

Read this when touching `packages/ui` shared components or text embedded in reusable UI primitives.

## Role

The UI package provides reusable primitives. It should avoid owning product-domain copy. Domain copy
belongs in the app using the component unless the label is truly generic.

## Allowed shared labels

- Save
- Cancel
- Delete
- Review
- Confirm
- Decline
- Promote
- Start
- End

Use domain labels from the app context when a component renders product concepts.

## Avoid

- Do not bake workspace, project, tenant, or site into reusable components.
- Do not bake publish into reusable components.
- Do not make a shared component decide whether a key is public or secret. The calling app supplies
  Client Key or API Key copy.

## Related context

- Control Panel context: [`../../apps/control-panel/CONTEXT.md`](../../apps/control-panel/CONTEXT.md)
- Control Plane API context: [`../../apps/control-plane-api/CONTEXT.md`](../../apps/control-plane-api/CONTEXT.md)
