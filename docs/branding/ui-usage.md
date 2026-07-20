# Using the splitch UI system

The practical guide for building screens (agents included). The brand rationale
and token values live in [design-tokens.md](design-tokens.md); this file is the
"how do I actually build a page that looks right" contract.

## The stack

- **shadcn/ui**, style `base-nova`, on **Base UI** (`@base-ui/react`) — not Radix.
- **Tailwind v4**, CSS-first config. No `tailwind.config.js`; tokens live in
  `packages/ui/src/theme.css` (+ `styles/palette.css`, `styles/semantic.css`).
- Icons: **lucide-react**. Toasts: **sonner** (`@splitch/ui/components/sonner`).
- Components are vendored copies in `packages/ui/src/components/` — update via
  `pnpm dlx shadcn@latest add <name>` **run from `packages/ui/`** (use
  `add --diff` to merge upstream changes into adapted files).

## Importing

```ts
import { Button } from "@splitch/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@splitch/ui/components/tabs";
import { PageShell } from "@splitch/ui/layout/page-shell";
import { EmptyState } from "@splitch/ui/state/empty-state";
import { cn } from "@splitch/ui/lib/utils";
```

Apps import the theme once: `@import "@splitch/ui/theme.css";` at the top of the
app stylesheet. Both apps already do this; do not fork it.

## Theming rules (the ones that keep it from going muddy)

1. **Only semantic classes.** `bg-background`, `text-foreground`, `bg-card`,
   `text-muted-foreground`, `border-border`, `bg-primary`, `bg-arm-control`,
   `bg-arm-treatment`, `text-success-foreground`… Never `bg-[#2563d9]`, never
   `bg-brand-control-500` in app code. If a class starts with a raw palette
   name, it will not theme.
2. **No brand atmosphere.** Brand color appears at full saturation on bounded
   shapes only (buttons, chips, the split track, plot marks, focus rings).
   Never as a low-alpha wash or gradient over a large surface. Page and section
   backgrounds alternate `bg-background` / `bg-muted` only.
3. **Both modes always.** Light and dark are both first-class and resolve
   automatically through the role tokens. If you follow rule 1 you get dark
   mode for free. Manual override: `ThemeToggle`
   (`@splitch/ui/components/theme-toggle`); its `themeInitScript` must be
   inlined in `<head>` (marketing `__root.tsx` shows how).
4. **Chartreuse discipline.** `bg-arm-treatment` fills pair with
   `text-arm-treatment-contrast`; chartreuse **text** uses
   `text-arm-treatment-foreground`. Chartreuse appears only where
   Control-vs-Treatment meaning exists. Success is its own green, never
   chartreuse.
5. **Mono is a signal.** Flag keys, IDs, stats, CLI commands, code:
   `font-mono`. Eyebrows: duotone dots + `font-mono text-xs uppercase
tracking-wide text-arm-control` (see marketing `SectionEyebrow`). Prose stays
   sans.
6. **Display type.** Headings `2xl`+: `font-display font-bold tracking-tight`.
   Hero scale: `text-4xl sm:text-5xl lg:text-6xl`. Type accents come from
   punctuation, not word coloring: a display headline ends on one arm-colored
   period (`text-arm-control`, or `text-arm-treatment` when the sentence lands
   on the treatment/agent side). Never set light-mode body text in chartreuse.

## Layout recipes

- Page container: `mx-auto w-full max-w-6xl px-4 sm:px-6` (marketing) or
  `PageShell` (panel).
- Section rhythm: `py-16 sm:py-20`, alternating `bg-background` / `bg-muted`,
  separated by `border-t border-border`.
- Cards: `rounded-xl border border-border bg-card p-5 shadow-xs` (quiet) or
  `shadow-md` (featured). Structure comes from hairlines, not heavy shadows.
- Mobile-first: single column by default, `sm:`/`lg:` grid splits. Any wide
  element (tables, code) wraps in `overflow-x-auto` inside a `min-w-0` parent.

## Live references

- **Component gallery:** `/kitchen-sink` in the control panel — every primitive
  rendered against the role layer, with a system/light/dark switcher.
- **Marketing exemplars:** `apps/marketing/src/routes/index.tsx` (hero with the
  Split signature, section rhythm) and `routes/quickstart.tsx` (Tabs, Table,
  Badge, code blocks, step sequence).
- **The Split signature:** `apps/marketing/src/components/split-visual.tsx` —
  the only place both brand hues go loud together. Reuse the arm tokens; do not
  invent new split renderings per screen.

## Extending the library

- Need a stock shadcn component we don't have? `pnpm dlx shadcn@latest add
<name>` from `packages/ui/`, then align it with Biome (`npx biome check
--write src`) and keep the adaptation minimal (named type imports; suppression
  comments only with a reason).
- Need a splitch-specific component? It goes in `packages/ui` only if both apps
  use it (the deletion test); otherwise it lives in the app that needs it and
  composes ui primitives.
- New color/role? Add a **role** to `styles/semantic.css` (light + dark via
  `light-dark()`) and document it in design-tokens.md §2.5. Never hardcode a
  hex in a component.
- Motion: use `--duration-*` / `--ease-*` tokens; every animation needs a
  `prefers-reduced-motion: reduce` fallback (see marketing `app.css`).
