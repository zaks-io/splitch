# splitch — Brand & Design Tokens

The single source of truth for splitch's visual identity. The control panel and
the marketing site compose from **one** token set defined here; neither forks the
palette (per `docs/spec/frontend/package-boundaries-ui-component-layer.md`). The
token **names** are pinned in `packages/ui/src/theme.css` (Tailwind 4 `@theme`
block); the **values** below are authoritative. When a value changes, change it
here and in `theme.css` together.

Terms (`Control`, `Treatment`, `Variant`, `Flag`, `Experiment`, `Environment`,
`Client Key`, `API Key`) are used exactly as `CONTEXT.md` defines them.

---

## 1. The idea in one line

**splitch is the moment one path becomes two — made legible, measured, and safe to ship.**

Every brand decision derives from that. The product's literal job is the _split_:
Control vs Treatment, `dev` vs `prod`, flag-on vs flag-off, the diff between what
is live and what you propose. The identity encodes that split rather than
decorating around it.

**Register:** developer infrastructure. Near-black ink on white, a disciplined
neutral ramp, hairline borders, monospace used as a _signal_ (keys, code, data),
and generous whitespace. Calm and precise where the product is dense (tables,
diffs, locked fields, confidence intervals); confident and large where it sells
(the marketing hero). The reference vibe is Resend-clean; the divergence is the
duotone split system and the editorial grotesk, both of which are ours.

---

## 2. Color

### 2.1 The split duotone — the signature

Two brand hues carry the product's core concept. They are **a pair**, always
assigned the same way, everywhere:

- **`brand-control` — Cobalt.** The Control arm. The reference. The current,
  live, "what is."
- **`brand-treatment` — Chartreuse.** The Treatment arm. The challenger. The
  proposed, the new, "what could be."

This assignment is **load-bearing, not aesthetic.** A confidence-interval plot, a
promotion diff, an allocation bar, and the marketing hero gradient all read
left-to-right as Control→Treatment because the colors are consistent. Do not swap
them per screen.

| token                       | hex       | role                                                           |
| --------------------------- | --------- | -------------------------------------------------------------- |
| `--color-brand-control-50`  | `#EEF3FD` | cobalt tint — control fills, hover wash                        |
| `--color-brand-control-100` | `#D6E2FA` | cobalt tint                                                    |
| `--color-brand-control-300` | `#7DA0EE` | cobalt — borders, secondary marks                              |
| `--color-brand-control-500` | `#2563D9` | **cobalt — the Control hue.** Primary brand, CTAs, control arm |
| `--color-brand-control-600` | `#1E4FB8` | cobalt — pressed / hover-darken                                |
| `--color-brand-control-700` | `#193F94` | cobalt — text on light, focus ring base                        |
| `--color-brand-control-900` | `#11265A` | cobalt ink                                                     |

| token                         | hex       | role                                                             |
| ----------------------------- | --------- | ---------------------------------------------------------------- |
| `--color-brand-treatment-50`  | `#F6FCDF` | chartreuse tint — treatment fills, wash                          |
| `--color-brand-treatment-100` | `#ECF9B5` | chartreuse tint                                                  |
| `--color-brand-treatment-300` | `#CEEF4F` | chartreuse — borders, secondary marks                            |
| `--color-brand-treatment-500` | `#B4F000` | **chartreuse — the Treatment hue.** Treatment arm, signal accent |
| `--color-brand-treatment-600` | `#94C500` | chartreuse — pressed / on-white text-safe step                   |
| `--color-brand-treatment-700` | `#6E9300` | chartreuse — text-on-light (AA), badges                          |
| `--color-brand-treatment-900` | `#374A00` | chartreuse ink                                                   |

> **Chartreuse discipline.** `#B4F000` is luminous and **fails contrast as text on
> white.** Use `--color-brand-treatment-500` for _fills, markers, plot lines, and
> arm chips_; for chartreuse _text_ on a light surface, step down to
> `--color-brand-treatment-700` (`#6E9300`, AA on white). On near-black surfaces
> the 500 is text-safe and is the product's electric signature. This is the one
> place the brand is loud — keep everything around it quiet.

> **No atmosphere. Ever.** Brand hues appear at **full saturation on bounded
> shapes** (the split track, CTAs, badges, chips, focus rings, plot marks) —
> never as low-alpha washes or gradients over large surfaces. Chartreuse at 18%
> alpha over near-black is olive mud; cobalt at 24% is murk. Backgrounds stay on
> the neutral ramp in both modes; the duotone is ink on shapes, not weather.
> (Exception: the small `--accent` / `*-muted` fills the role layer defines for
> compact elements like badges and hovers.)

`--color-brand-*` (the generic brand aliases the spec names) resolve to the
**control** ramp: `--color-brand-500: var(--color-brand-control-500)`. Cobalt is
the primary brand color; chartreuse is its deliberate counterpart, not a
co-equal default. A screen that needs "the brand color" and is not encoding the
split gets cobalt.

### 2.2 Neutrals — the Resend-clean ramp

Cool-gray, near-black ink. This is 90% of every panel surface. Whitespace and
hairline borders do the structural work; color is reserved for meaning.

| token                 | hex       | role                                    |
| --------------------- | --------- | --------------------------------------- |
| `--color-neutral-0`   | `#FFFFFF` | page / card background (light)          |
| `--color-neutral-50`  | `#F8F9FB` | subtle fill, zebra rows, inset panels   |
| `--color-neutral-100` | `#EEF0F4` | hairline-on-fill, hover                 |
| `--color-neutral-200` | `#E1E4EA` | **default border / divider (hairline)** |
| `--color-neutral-300` | `#CBD0D9` | strong border, disabled outline         |
| `--color-neutral-400` | `#9BA3B0` | placeholder, disabled text              |
| `--color-neutral-500` | `#6B7280` | muted / secondary text, captions        |
| `--color-neutral-600` | `#4B5563` | body text on light (secondary)          |
| `--color-neutral-700` | `#374151` | body text on light                      |
| `--color-neutral-900` | `#111419` | **primary ink** — headings, key text    |
| `--color-neutral-950` | `#0A0C10` | near-black — dark-surface background    |

### 2.3 Semantic — status, never decoration

`success` is its own green, deliberately **not** the chartreuse, so "a test
passed / it resolves" never collides with "this is the Treatment arm." Keeping
them distinct is a fail-loud requirement: a green check must not be mistaken for
a brand mark.

| token                     | hex       | role                                               |
| ------------------------- | --------- | -------------------------------------------------- |
| `--color-success-500`     | `#16A34A` | resolves / passing / healthy                       |
| `--color-success-50`      | `#ECFDF3` | success wash                                       |
| `--color-success-700`     | `#15803D` | success text on light (AA)                         |
| `--color-warning-500`     | `#D97706` | graduated SRM caution, guardrail near-bound        |
| `--color-warning-50`      | `#FFFBEB` | warning wash                                       |
| `--color-warning-700`     | `#B45309` | warning text on light (AA)                         |
| `--color-destructive-500` | `#DC2626` | SRM firing, kill switch, removed-in-diff, errors   |
| `--color-destructive-50`  | `#FEF2F2` | destructive wash                                   |
| `--color-destructive-700` | `#B91C1C` | destructive text on light (AA)                     |
| `--color-info-500`        | `#2563D9` | informational = cobalt (`brand-control-500` alias) |

**Diff colors** (promotion / approval diff screens) reuse semantics so the
product's color grammar stays small: **added = `success`**, **removed =
`destructive`**, **changed = `warning`**. The duotone is reserved for arm
identity, not diff state — a diff is about safety, not Control-vs-Treatment.

### 2.4 Light & dark modes — two complete themes

Both modes are first-class for the **whole product** (control panel and
marketing), not light-with-a-dark-hero. They are realized through a **semantic
role layer** (§2.5): the raw palette above never changes between modes; the
_role_ tokens flip.

**Mode selection — system default, manual override.**

| selector                              | result                                         |
| ------------------------------------- | ---------------------------------------------- |
| `:root`                               | light defaults                                 |
| `@media (prefers-color-scheme: dark)` | dark, when the OS asks and no explicit choice  |
| `[data-theme="dark"]` on `<html>`     | dark, explicit user choice (**wins over OS**)  |
| `[data-theme="light"]` on `<html>`    | light, explicit user choice (**wins over OS**) |

Absent `data-theme` ⇒ follow the OS. A user toggle sets/clears the attribute and
persists the choice (`ThemeToggle` in `@splitch/ui/components/theme-toggle`,
plus its exported `themeInitScript` inlined in `<head>` to apply the stored
choice before first paint). `color-scheme` is set per mode so native form
controls and scrollbars match.

**Implementation:** the role layer resolves via CSS `light-dark()` driven by
`color-scheme` (`:root { color-scheme: light dark }`, forced by
`[data-theme="light|dark"]`), so each role is declared once instead of per-mode
blocks. Components that need a mode-conditional class use the `dark:` variant,
which `@custom-variant dark` maps to the same explicit-or-OS logic.

**Dark is designed, not inverted.** The care points that separate a real dark
theme from a flipped one:

- **Surfaces are layered, never flat black.** Base `--color-neutral-950`
  (`#0A0C10`); cards/panels sit on `--color-dark-raised` (`#13161C`); popovers on
  `--color-dark-raised-2`. Depth comes from these rungs, not from shadows.
- **Cobalt steps up for text/icons.** Cobalt `500` as _fill_ stays (white text on
  it is still AA). But cobalt-as-_text/icon_ on near-black is muddy and sub-AA, so
  `--color-brand-text` and `--color-arm-control` resolve to
  `--color-brand-control-400` (`#4F86E8`) in dark.
- **Chartreuse glows — the signature is loudest here.** `--color-arm-treatment`
  stays `treatment-500`; chartreuse-as-text steps to `treatment-400`. Dark is
  where the split mark and the treatment arm shine.
- **Washes are low-alpha, not light tints.** Success/warning/danger/brand
  backgrounds use `rgb(... / 0.16–0.18)` over the dark surface — dragging the
  light `#ECFDF3`-style tints onto black turns them to mud.
- **Shadows become borders.** On dark, `--shadow-*` resolve to a `0 0 0 1px`
  black ring plus a soft drop, so elevation reads as a hairline edge, not a glow.
- **Status stays loud.** SRM-firing red, guardrail amber, and the success check
  all keep AA contrast on dark via the `*-400` rungs.

### 2.5 The semantic role layer — the only tokens components touch

Components **never** reference raw palette tokens (`--color-neutral-900`,
`--color-brand-control-500`). They reference **roles**, which resolve per mode.
This is what lets every component theme for free and guarantees neither app
forks the palette. Role names follow **shadcn's variable contract** (ADR-0020),
so stock shadcn components drop in unmodified; splitch-only roles (arms, status,
charts) extend the same layer.

| role token                                       | means                                | light → dark                           |
| ------------------------------------------------ | ------------------------------------ | -------------------------------------- |
| `--background` / `--foreground`                  | page surface / primary ink           | `neutral-0/900` → `neutral-950/50`     |
| `--card` / `--card-foreground`                   | card, panel                          | `neutral-0` → `dark-raised`            |
| `--popover` / `--popover-foreground`             | menus, popovers                      | `neutral-0` → `dark-raised-2`          |
| `--primary` / `--primary-foreground`             | primary action fill (cobalt)         | `control-500` + white (both)           |
| `--secondary` / `--secondary-foreground`         | quiet fill button, chips             | `neutral-50` → `dark-hover`            |
| `--muted` / `--muted-foreground`                 | inset well / captions, meta          | `neutral-50/500` → `#0D1015`/`#7C8492` |
| `--accent` / `--accent-foreground`               | compact brand wash (badges, hovers)  | `control-50/700` → `.16-alpha/400`     |
| `--destructive`                                  | errors, kill switch, removed-in-diff | `500` → `400`                          |
| `--border` / `--input`                           | hairline / control border            | `neutral-200` → `dark-border(-strong)` |
| `--ring`                                         | keyboard focus                       | `control-500` → `control-400`          |
| `--overlay`                                      | modal scrim                          | `rgb(ink/.45)` → `rgb(0 0 0/.6)`       |
| `--arm-control` / `-contrast`                    | **Control arm** (plots, allocation)  | `control-500` → `control-400`          |
| `--arm-treatment` / `-contrast`                  | **Treatment arm**                    | `treatment-500` (both — glows on dark) |
| `--arm-treatment-foreground`                     | chartreuse as text                   | `treatment-700` → `treatment-400`      |
| `--success` / `-foreground` / `-muted`           | passing / resolves                   | `500/700/50` → `400/400/.16-alpha`     |
| `--warning` / `-foreground` / `-muted`           | SRM caution / guardrail near         | `500/700/50` → `400/400/.18-alpha`     |
| `--chart-1..5`                                   | series colors (1=cobalt, 2=chartr.)  | `500s` → `400s`                        |
| `--sidebar*` (8 tokens, shadcn sidebar contract) | panel navigation shell               | `neutral-50`-family → `#0D1015`-family |

Authoritative values live in `packages/ui/src/styles/semantic.css` (the
`light-dark()` role layer); the raw palette is `packages/ui/src/styles/palette.css`.
In classes these surface through Tailwind as `bg-background`, `text-foreground`,
`border-border`, `bg-arm-treatment`, `text-success-foreground`, etc. **Rule: if
a component hardcodes a `--color-neutral-*` or `--color-brand-control-*`, it is
a bug — it will not theme.** New surfaces add a _role_, not a raw reference.

---

## 3. Typography

Three roles. The pairing is deliberate: an editorial grotesk gives splitch
confidence the default Inter-everything stack lacks, while the mono is a _signal_
that this is a tool built by and for engineers.

### 3.1 Families

| token            | stack                                                             | role                                         |
| ---------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `--font-display` | `"Söhne", "Inter Variable", "Inter", system-ui, sans-serif`       | headings, hero, large numerals               |
| `--font-sans`    | `"Inter Variable", "Inter", system-ui, -apple-system, sans-serif` | body, UI labels, controls                    |
| `--font-mono`    | `"IBM Plex Mono", ui-monospace, "SFMono-Regular", monospace`      | **keys, code, IDs, metrics, CLI, plot axes** |

**The fonts actually ship.** `packages/ui/src/theme.css` imports self-hosted
webfonts (`@fontsource-variable/inter` with the `opsz` axis, and
`@fontsource/ibm-plex-mono` 400/500/600); Vite bundles the woff2 subsets. Inter
Variable's optical-sizing axis (`font-optical-sizing: auto` on `body`) renders
the display cut automatically at heading sizes — no separate Display file.

**Licensing note.** Söhne is commercial (Klim). Until licensed, the display
stack resolves to Inter Variable tightened (see tracking below) — the token name
stays `--font-display` so swapping the licensed face later is a one-line change,
no component edits. IBM Plex Mono and Inter are OFL/SIL, free to ship.

### 3.2 The mono is doing real work

Monospace is not a code-block-only choice here. Anything that is a **literal
machine value** is set in mono, because in splitch those values are the product:

`ck_live_a8f2…` (Client Key) · `flag.checkout-model` (Flag key) · `app_7Qm…`
(IDs) · `+4.2% [1.1, 7.3]` (lift + CI) · `splitch flag promote --from dev` (CLI)
· `p = 0.003` (stats).

This is the rule that makes the UI feel engineered: **if a human typed it into a
config or a terminal, or a machine generated it as an identifier or a number,
it's mono.** Prose about those things stays sans.

### 3.3 Type scale

A modular scale (~1.20, major-ish) tuned for dense data screens at the small end
and a confident marketing hero at the top.

Sizes live in the Tailwind v4 `--text-*` namespace with a paired default
line-height (`--text-<size>--line-height`), so `text-sm`, `text-4xl`, etc. carry
the right leading automatically.

| token         | size               | line-height | typical use                                         |
| ------------- | ------------------ | ----------- | --------------------------------------------------- |
| `--text-2xs`  | `11px / 0.6875rem` | `1.45`      | dense table meta, plot axis labels                  |
| `--text-xs`   | `12px / 0.75rem`   | `1.45`      | captions, badges, secondary meta, eyebrows          |
| `--text-sm`   | `13px / 0.8125rem` | `1.5`       | table body, secondary UI text                       |
| `--text-base` | `15px / 0.9375rem` | `1.55`      | **body default** (15px, not 16 — dense-but-legible) |
| `--text-lg`   | `18px / 1.125rem`  | `1.55`      | lead paragraph, card titles                         |
| `--text-xl`   | `22px / 1.375rem`  | `1.35`      | section headings (H3)                               |
| `--text-2xl`  | `28px / 1.75rem`   | `1.25`      | screen titles (H2)                                  |
| `--text-3xl`  | `36px / 2.25rem`   | `1.15`      | page titles (H1), mobile hero                       |
| `--text-4xl`  | `52px / 3.25rem`   | `1.05`      | marketing sub-hero, section headlines               |
| `--text-5xl`  | `64px / 4rem`      | `1.02`      | marketing hero (tablet)                             |
| `--text-6xl`  | `76px / 4.75rem`   | `1.0`       | marketing hero (desktop)                            |

| token                    | value | use                                |
| ------------------------ | ----- | ---------------------------------- |
| `--font-weight-normal`   | `400` | body                               |
| `--font-weight-medium`   | `500` | UI labels, table headers, emphasis |
| `--font-weight-semibold` | `600` | card titles, H3/H2                 |
| `--font-weight-bold`     | `700` | H1, hero, big numerals             |

| token               | value     | use                                                     |
| ------------------- | --------- | ------------------------------------------------------- |
| `--tracking-tight`  | `-0.02em` | **display headings ≥ `2xl`** (grotesk wants tightening) |
| `--tracking-snug`   | `-0.01em` | `lg`/`xl` headings                                      |
| `--tracking-normal` | `0`       | body                                                    |
| `--tracking-wide`   | `0.04em`  | **eyebrows / overline labels** (uppercase mono)         |

**Rules of thumb**

- Display headings (`2xl`+): `font-display font-bold tracking-tight`. Tight tracking is what makes the grotesk read as _designed_ rather than default.
- Eyebrows / section overlines: `font-mono text-xs uppercase tracking-wide text-muted-foreground`. (See §5, signature.)
- Body never exceeds ~70ch measure.

---

## 4. Space, radius, shadow, motion

### 4.1 Spacing — 4px grid

Tailwind v4's default spacing scale (`--spacing: 0.25rem`; `p-4` = 16px) — no
custom overrides. The panel is dense; lean on the small end (`2`–`4`) inside
components, the large end (`8`–`24`) between sections.

### 4.2 Radius — restrained, technical

Small radii. The product reads as precise instrumentation, not a consumer app.

| token           | value    | use                                        |
| --------------- | -------- | ------------------------------------------ |
| `--radius-sm`   | `4px`    | inputs, badges, chips, table cells         |
| `--radius-md`   | `6px`    | **default** — `--radius` resolves here     |
| `--radius-lg`   | `10px`   | buttons (shadcn `rounded-lg`), menus       |
| `--radius-xl`   | `14px`   | cards, modals, marketing panels            |
| `--radius-2xl`  | `20px`   | large marketing surfaces                   |
| `--radius-full` | `9999px` | pills, avatars, the split-allocation track |

### 4.3 Shadow — hairlines first, then soft elevation

Borders carry structure; shadows only lift things that genuinely float. Cool-gray
shadow, never pure black.

| token            | value                                   | use                              |
| ---------------- | --------------------------------------- | -------------------------------- |
| `--shadow-xs`    | `0 1px 1px 0 rgb(16 19 25 / 0.04)`      | subtle card lift                 |
| `--shadow-sm`    | `0 1px 2px 0 rgb(16 19 25 / 0.05)`      | cards, raised rows               |
| `--shadow-md`    | `0 4px 12px -2px rgb(16 19 25 / 0.08)`  | dropdowns, popovers              |
| `--shadow-lg`    | `0 12px 32px -4px rgb(16 19 25 / 0.12)` | modals, dialogs                  |
| `--shadow-focus` | `0 0 0 3px rgb(37 99 217 / 0.35)`       | **keyboard focus ring** (cobalt) |

### 4.4 Motion — deliberate, reduced-motion respected

Motion confirms state changes; it does not perform. One signature moment (§5),
everything else is a quiet 150ms.

| token               | value                        | use                              |
| ------------------- | ---------------------------- | -------------------------------- |
| `--duration-fast`   | `120ms`                      | hover, focus, small toggles      |
| `--duration-base`   | `180ms`                      | menus, popovers, tab change      |
| `--duration-slow`   | `320ms`                      | the split signature, hero reveal |
| `--ease-standard`   | `cubic-bezier(0.2, 0, 0, 1)` | most transitions                 |
| `--ease-emphasized` | `cubic-bezier(0.3, 0, 0, 1)` | the split animation              |

All motion is wrapped in `@media (prefers-reduced-motion: reduce)` → instant.

---

## 5. The signature: the Split

The one element splitch is remembered by. It is **not** decoration bolted on — it
is the literal rendering of the product: **a single track that divides into
Control (cobalt) and Treatment (chartreuse).**

```
 before                            after
┌──────────────────────────┐     ┌─────────────┬────────────┐
│                          │ →   │  control    │ treatment  │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │     │  ▓▓ cobalt   │ ░░ chartr. │
└──────────────────────────┘     └─────────────┴────────────┘
        one path                     it splits, 50 / 50
```

**Where it appears (earning its place each time, never ornamental):**

1. **Allocation control** — the Experiment setup allocation slider _is_ this
   track. Dragging the divider sets the split; the colors are the arm colors.
   The signature and the control are the same object.
2. **Hero (marketing)** — on load, a single cobalt bar splits into cobalt +
   chartreuse over `--duration-slow` with `--ease-emphasized` (reduced-motion:
   renders already-split). This is the page-load moment.
3. **CI plot** — Control series cobalt, Treatment series chartreuse, same
   assignment as the track. The plot reads as the split, measured.
4. **Logo mark** — a vertical hairline dividing a square into cobalt | chartreuse
   halves. The `|` in `split|ch` is the divider. Wordmark is
   `--font-family-display`, weight 700, `--letter-spacing-tight`, lowercase, with
   the pipe rendered in the two-tone divider.

**Restraint rule.** The split is the _only_ place both brand hues appear together
loud. Everywhere else: cobalt for action, chartreuse held back to arm-identity
and the rare signal moment. If a screen has no Control-vs-Treatment meaning, it
has no chartreuse.

**Structure encodes truth, not order.** splitch does **not** use generic numbered
markers (01/02/03) as decoration. Numbering appears only where order is real and
load-bearing: **Run history** (Run 1 → Run 2, a true sequence where order carries
meaning) and the onboarding quickstart (a genuine step sequence). Elsewhere,
structure is carried by the duotone, hairline dividers, and mono eyebrows — never
by ornamental numerals.

---

## 6. Voice (so copy doesn't feel templated)

Written from the user's side of the screen, in the product's voice. Full
guidance: `apps/marketing/CONTEXT.md` and `CONTEXT.md` reserved language.

- **Plain verbs, sentence case, no filler.** "Promote to prod," not "Submit."
- **An action keeps its name through the flow.** The button says _Promote_ → the
  toast says _Promoted_. _Start a Run_ → _Run 1 started_.
- **Use the reserved terms exactly.** Promote / Start / End — never _publish_.
  Variant — never _variation/arm/bucket_. App — never _project/workspace_.
- **Errors are fail-loud and actionable, never apologetic or vague** (ADR-0036).
  "SRM firing (p = 0.0004) — diagnose the imbalance before promoting," not
  "Something went wrong." A failure is always observable; never a disguised
  default.
- **Empty states teach** — one concept line, one primary action, the CLI/MCP
  equivalent. Never a blank panel.
- **Keys are spoken precisely.** Client Key is public ("safe to embed"); API Key
  is secret ("shown once") — copy never blurs the two.

---

## 7. Accessibility & quality floor

Non-negotiable, built in, not announced:

- **Contrast holds in both modes.** Body and UI text meet WCAG AA (4.5:1); large
  display meets 3:1 — in light _and_ dark. The chartreuse text caveat (§2.1) and
  the dark `*-400` step-ups (§2.4) exist to keep this true on both surfaces.
- **The duotone never carries meaning by hue alone.** Control/Treatment are
  always also labeled (text, position, or a shape marker) — the split survives
  color-vision deficiency and grayscale. Cobalt/chartreuse are luminance-separated
  precisely so the CI plot still reads in CVD.
- **Keyboard focus is always visible** — `--shadow-focus` (cobalt ring), never
  `outline: none` without a replacement.
- **Reduced motion respected** — the split signature and hero render in their
  final state under `prefers-reduced-motion: reduce`.
- **Responsive to mobile** — the marketing site and the panel's read surfaces
  reflow; dense editing tables get horizontal scroll with a sticky first column,
  not a broken layout.

---

## 8. How tokens flow to code

```
docs/branding/design-tokens.md      ← authoritative values (this file)
        │  values copied into
        ▼
packages/ui/src/theme.css           ← entry: tailwind, fonts, @custom-variant dark, base layer
  ├── src/styles/palette.css        ← @theme raw palette + type/radius/shadow/motion (mode-agnostic)
  └── src/styles/semantic.css       ← role layer (shadcn names), light-dark(), [data-theme]
        │  consumed by — components reference ROLE tokens only
        ├── packages/ui/src/components  ← shadcn (base-nova on Base UI) component copies
        ├── apps/control-panel      ← composes role tokens; never forks; /kitchen-sink gallery
        └── apps/marketing          ← split hero / quickstart are compositions from these tokens
```

**Two layers, one rule.** The `@theme` block is the raw palette and never changes
between modes. The role layer (`--color-surface`, `--color-text`, `--color-arm-*`,
…) flips per mode. Components touch **only** roles — a hardcoded
`--color-neutral-*` / `--color-brand-control-*` in a component is a bug, because
it will not theme. Set `data-theme` on `<html>` to override the OS (§2.4).

Marketing-only treatments (the split hero, large-format CTA) are
**marketing-owned compositions built from these shared tokens** — never a forked
palette, never a one-consumer `ui` component
(`docs/spec/frontend/package-boundaries-ui-component-layer.md`).

**Preview:** `docs/branding/preview.html` is the full brand sheet with a
Light / Dark / System toggle — the same components driven by the semantic layer,
so flipping the toggle shows every surface theme in place. The toggle sets
`data-theme` on `<html>`; System clears it and follows the OS.
