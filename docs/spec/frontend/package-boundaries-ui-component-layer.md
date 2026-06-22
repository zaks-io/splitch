# Package structure, deletion-test justification, and component ownership rules

## Three tiers (the monorepo split)

```
packages/
  ui/              design system — brand + primitives
  contracts/       shared types + typed API client
apps/
  control-panel/   Control Panel Worker
  marketing/  Marketing Worker
```

### `packages/ui` — the design system seam

**What it contains:**

- Tailwind 4 `@theme` token definitions (the brand palette, spacing, typography, shadows, radii)
- Framework primitives: `Button`, `Card`, `Input`, `Select`, `Dialog`, `Badge`, `Tooltip`, `Table`
- Layout primitives: `Stack`, `Grid`, `Divider`, `PageShell`
- State surfaces: `Skeleton` (per content type), `EmptyState`, `ErrorPage`
- Named empty-state / error components: `<AccessDeniedPage />`, `<NotFoundPage />`, `<AppErrorPage />`,
  `<StaleDataToast />`

**What it does NOT contain:**

- Any mention of `Run`, `Experiment`, `Exposure`, `Flag`, `Variant`, `Metric`, `Segment`
- Any import from `packages/contracts`
- Any route-aware logic (no `useParams`, no navigation)

**Deletion test:** two real consumers (Control Panel app, Marketing app) → the seam is real,
not speculative.

**Tokens are the single source of brand.** Color changes propagate to both surfaces from one edit.
Both apps compose from the same token set; neither forks the palette. Marketing-only visual treatments
(gradient hero, large-format CTA) are **marketing-owned compositions** built from shared `ui` tokens —
never a fork of the palette, never a new `ui` component with one consumer.

**Token location:** `packages/ui/src/theme.css` (Tailwind 4 `@theme` block). The actual token values
are defined by the branding guide. Placeholder token names are pinned here; values are filled in from
[`docs/branding/design-tokens.md`](../../branding/design-tokens.md).

Token categories (names pinned, values deferred to branding guide):
| category | example tokens |
|-------------|---------------------------------------------------|
| color | `--color-brand-*`, `--color-neutral-*`, `--color-destructive-*`, `--color-success-*` |
| spacing | `--spacing-*` (4 px grid) |
| typography | `--font-family-*`, `--font-size-*`, `--font-weight-*`, `--line-height-*` |
| radius | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-full` |
| shadow | `--shadow-sm`, `--shadow-md`, `--shadow-lg` |

**Component API stability:** breaking changes to `ui` component props (removed props, renamed
variants, changed slot layout) require sign-off from both consumer teams (Control Panel + Marketing
Site) before merging. Additive changes (new optional prop, new variant) do not require cross-consumer
sign-off.

### `packages/contracts` — shared types + typed API client

**What it contains:**

- Zod schemas for all API request/response shapes (shared between server and client)
- The typed `hc` client (Hono RPC client generated from the schemas)
- `ErrorResponse` and `FieldError` shapes (see [mutation-data-flow.md](./mutation-data-flow.md))
- `NudgePayload` type
- `AppMembership`, `OrgRole`, `AppRole` types

**Consumed by:** Control Panel app, Marketing app (for read-only API calls), SDK (types only)
**Does not contain:** React components, Tailwind classes, routing logic, query-key factory

The contracts package is independent of the frontend. It is safe for the SDK to import only the
type definitions without pulling in React or Tailwind.

### `apps/control-panel` — Control Panel Worker

- Owns all domain-aware components: `RunStatusBadge`, `SRMIndicator`, `AllocationSlider`,
  `ExperimentCard`, `MetricResultRow`, `VariantPill`, etc.
- Owns the query-key factory (`lib/query-keys.ts`)
- Owns the WebSocket lifecycle (the `/{orgSlug}/{appSlug}/{env}` layout route)
- Owns all route loaders and server-side logic
- Imports from `packages/ui` and `packages/contracts`; never the reverse

Domain-aware components (one consumer = Control Panel) stay in the Control Panel app. Extracting them
to `ui` would fail the deletion test (one consumer = speculative indirection).

### `apps/marketing` — Marketing Worker

- Mostly prerendered (static HTML at build time via TanStack Start per-route prerender)
- Where it fetches live data (e.g. live pricing), it uses TanStack Query with the same discipline
  as the Control Panel (no Redux/Zustand, refetch-on-nudge)
- Shares `packages/ui` primitives with the Control Panel; marketing-specific compositions (hero
  sections, feature grids, testimonial blocks) live in `apps/marketing/components/`
- Does NOT import from `apps/control-panel`

## What the deletion test gates

| candidate seam       | consumers                          | verdict                             |
| -------------------- | ---------------------------------- | ----------------------------------- |
| `packages/ui`        | 2 (Control Panel, Marketing)       | real seam — extract                 |
| query-key factory    | 1 (Control Panel)                  | stays in Control Panel — no extract |
| `RunStatusBadge`     | 1 (Control Panel)                  | stays in Control Panel — no extract |
| `packages/contracts` | 3+ (Control Panel, Marketing, SDK) | real seam — extract                 |
| WebSocket lifecycle  | 1 (Control Panel)                  | stays in Control Panel — no extract |

## Sources

- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
