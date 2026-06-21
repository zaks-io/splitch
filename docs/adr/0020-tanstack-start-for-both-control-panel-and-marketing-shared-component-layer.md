# TanStack Start for both the control panel and the marketing site; one shared component layer

**Status:** accepted

ADR-0017 committed **React 19 + TanStack Router/Query + Tailwind 4** but left the rendering model
open, and ADR-0019 referenced "**Under TanStack Start**" as a conditional. This ADR resolves both:
the **control panel and the marketing site are both TanStack Start apps**, each shipping as its
**own separate Worker**, both using **TanStack Query as the server-state store**, sharing **one
component library** so a component built for one renders unchanged in the other. There is no second
frontend framework, no SPA-vs-SSR split between the two surfaces, and no "marketing is built in X,
the app is built in Y" seam — the two are isolated at the deploy boundary, not the framework one.

## Context

The two surfaces have genuinely different shapes — marketing is mostly static, SEO-sensitive,
unauthenticated; the control panel is authenticated, data-dense, live (ADR-0019). The lazy reading
is "use a static-site generator for marketing, a SPA for the app." That gives two toolchains, two
component idioms, and a wall: a pricing-page card and a control-panel card become different
components that drift. The whole point of picking one framework is that the **marketing → product
visual handoff is the same components**, not a reskin.

TanStack Start spans both shapes from one model: it is the SSR/full-stack layer over the TanStack
Router that ADR-0017 already committed, so adopting it adds a rendering capability to an
already-chosen router rather than introducing a new framework. Its **server route loaders** seed the
TanStack Query cache for a correct, SEO-visible first paint (the exact mechanism ADR-0019 leans on),
and **prerendering** turns the mostly-static marketing routes into HTML at build time. Same router,
same loaders, same Query cache — the difference between a marketing route and a panel route is how
much of its data is static, not which framework renders it.

## Decisions

- **Both surfaces are TanStack Start apps.** Not "Start for the panel, SSG for marketing." One
  framework, one rendering model, one mental model for routing, loaders, and data fetching across
  the whole frontend.
- **TanStack Query is the server-state store on both.** ADR-0019 already pinned Query as the _sole_
  synced server-state store for the panel; marketing inherits the same discipline (no Redux/Zustand,
  no second copy of server state). Most marketing data is build-time static, so its Query usage is
  thin — but where it does fetch (e.g. live pricing, status), it reads through the same store the
  panel does.
- **One shared component layer** (a `ui` package in the monorepo, ADR-0017's Turborepo layout). A
  component is built once and is **interchangeable** between surfaces: a marketing CTA card and a
  panel card are the same primitives on the same Tailwind 4 design tokens. The deletion test passes
  — there are two real consumers (panel, marketing), and the shared package is substitutable behind
  its own boundary, so this is a real seam, not speculative indirection.
- **Rendering per route is a knob, not a framework choice.** Marketing routes are **prerendered**
  (static HTML at build, served from Cloudflare static assets — cheap, fast, crawlable). Panel routes
  are **SSR/hydrated** with loader-seeded Query caches, then ADR-0019's WebSocket attaches after
  hydration. The same Start app supports both per-route; we do not fork the toolchain to get static
  marketing pages.
- **Two separate Workers, one per surface.** The marketing site ships as its own Worker; the control
  panel ships as its own Worker. They serve different purposes (unauthenticated, mostly-static
  marketing vs. authenticated, live, data-dense panel) and are cleanly isolated — separate deploy
  units, separate blast radius, independent scaling and rollout. Both target the Cloudflare adapter
  on the same Wrangler + GitHub Actions path (ADR-0017). The shared `ui` package is consumed by both
  Workers at build time, so isolation at the deploy boundary does not cost component sharing.

## Considered options

- **SSG (Astro/11ty/etc.) for marketing + SPA/Start for the panel** — rejected. It is the obvious
  reading and it is the thing this ADR exists to refuse. Two toolchains and two component idioms put
  a wall between the marketing and product UIs precisely where we want them to share components; the
  shared-component goal is the whole reason to standardize. SSG's one real win (trivially static
  marketing) is already available _inside_ Start via per-route prerendering, so we get static
  marketing HTML without the second stack.
- **Plain SPA (TanStack Router, no Start) for both** — rejected. Router-only ships a client-rendered
  shell; marketing then has no server-rendered HTML for crawlers and a blank-until-JS first paint,
  and the panel loses the loader-seeded first paint ADR-0019 assumes. Start is the minimal addition
  that fixes both, over a router we already chose.
- **Next.js for both** — rejected. It would render and deploy on Workers and has the larger
  ecosystem, but it is a _different_ router/data model from the TanStack Router/Query already
  committed in ADR-0017 — adopting it would mean re-litigating 0017, not extending it. No advantage
  here outweighs throwing away a standing decision.
- **One Worker serving both surfaces** — rejected. Folding marketing and the panel into a single
  Worker would couple two surfaces with different security postures, traffic shapes, and release
  cadences into one deploy unit. Separate Workers keep the unauthenticated marketing surface and the
  authenticated panel cleanly isolated — independent deploys, blast radius, and scaling — at no cost
  to component sharing, which happens at build time through the `ui` package.

## Consequences

- **ADR-0017's open rendering model is resolved to TanStack Start**, and **ADR-0019's conditional
  "Under TanStack Start" becomes unconditional** — the loader-seeds-Query-cache, WebSocket-attaches-
  after-hydration flow it described is now the committed control-panel rendering path.
- **One frontend toolchain to build, test, and operate** — Biome/Vitest, Tailwind 4 tokens, and the
  `ui` package serve both surfaces. The marketing → product visual handoff is shared components, not
  a reskin, and design changes land in one place.
- **Marketing SEO/perf is handled by per-route prerendering**, not a separate static generator — the
  static-marketing requirement is met without a second stack.
- **No new server platform.** Both Workers deploy on Cloudflare via the adapter (ADR-0017); this is a
  frontend rendering/composition decision layered on the existing serving stack, and it touches
  neither the hot path (ADR-0009) nor the analytics sink (ADR-0010).
- **Two deploy units to operate** instead of one — accepted deliberately for the isolation it buys.
  The cost is paying for two Workers and two pipelines; both are negligible against keeping an
  unauthenticated marketing surface and the authenticated panel cleanly separated.
- **No maturity risk to carry.** TanStack Start on the Cloudflare Workers adapter is already proven
  in agent-paste (the shell ADR-0017 adopts), running fine — so this is adopting a working pattern,
  not betting on an unverified one.
