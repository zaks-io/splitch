# Frontend architecture

Status: designed (no code yet). Output of an upfront architecture grill on 2026-06-20.
Vocabulary: domain terms per [CONTEXT.md](../../CONTEXT.md). Builds directly on
[ADR-0017](../adr/0017-all-cloudflare-stack-workers-serving-and-control-tinybird-analytics.md)
(stack), [ADR-0018](../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
(identity in D1, app-enforced isolation),
[ADR-0019](../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
(live updates), and
[ADR-0020](../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
(TanStack Start, two Workers, shared `ui`).

## Where this came from

The ADRs pin the rendering _substrate_ — TanStack Start on two Workers, a shared `ui` package, TanStack
Query as the sole synced server-state store, a hibernating WebSocket per App for live updates. They do not
pin the _contracts between the pieces_: how code is split into packages, how the panel knows who you are,
how a WebSocket nudge maps to the caches it invalidates, when the socket connects, how errors and loading
are handled, or how mutations flow. This is that layer — below the ADRs, above the screens. It is not a UX
spec (no screen inventory) and not a glossary.

## The spine: one `appId`, four jobs

Everything below keys off a single value — the **active App's id**, carried in the URL as
`/app/:appId/...`. That one route param drives four otherwise-independent mechanisms, and because they all
read the same source they cannot disagree:

1. **Isolation check** — the loader validates the session's membership against `:appId` (or 403s). This is
   the application-enforced `app_id` boundary of ADR-0018, made explicit at the loader seam.
2. **Query-cache root** — every TanStack Query key is rooted at `['app', appId, ...]`, so one App's cache
   can never serve another's, and an App switch / logout can purge by prefix.
3. **Live-update DO** — the per-App fan-out DO is `idFromName(appId)` (ADR-0019); the socket connects to
   the DO named by the same `appId`.
4. **Socket lifecycle** — the socket is owned by the `/app/:appId` layout route, so "which DO am I
   connected to" is derived from the URL, not ambient client state.

App-in-the-URL (over a session-only "current app") is the deliberate choice that makes this work: the
isolation boundary is visible at every loader, panel state is shareable/bookmarkable, and the active App is
never hidden state that can drift from what the server believes.

## Package boundary

Three tiers. The rule for what becomes a package is the deletion test: two-plus real consumers, or it is
speculative indirection.

- **`ui`** — the design system: Tailwind 4 tokens (the `@theme`) plus framework primitives (Button, Card,
  Input, Dialog, skeletons, the designed error/empty states). Knows **nothing** about the domain — it never
  mentions a Run, Experiment, or Exposure. Two real consumers (panel, marketing) → a real seam. **`ui` is
  the single source of brand.** Tokens live here and nowhere else; both apps compose from them. A color
  changes in one place and both surfaces move.
- **`contracts`** — shared types and the typed read-API client (ADR-0017's contracts-first OpenAPI/Zod).
  Consumed by both apps (and the SDK), so it is its own package independent of the frontend.
- **panel app / marketing app** — each owns its **own** feature/page components, _composed from_ `ui`
  primitives. Anything domain-aware (a `RunStatusBadge`, an SRM panel) lives **inside** the app that uses
  it, not in a shared package — one consumer, so extracting it would be speculative indirection.

Marketing and the panel look like one product because they are built from the same primitives on the same
tokens; they are not the _same_ compositions (marketing's gradient hero, the panel's data tables differ).
When marketing wants a treatment the panel never uses, that is a marketing-only **component** built from
shared **tokens** — the palette is never forked, only the composition differs.

Brand drift is kept out by structure plus a forthcoming **branding guide** (the human reference for how to
apply the system), not by CI lint rules.

## Auth and the session boundary

Panel routes are SSR with loader-seeded Query caches (ADR-0020); the loader runs server-side on the Worker
on first paint, so it needs the authenticated identity at request time, before any client JS.

- **Session is a cookie**, validated server-side in the TanStack Start server handler against the D1
  identity/membership store (ADR-0018). The validated `{ userId, appId-memberships, role }` enters the
  **loader context**. Loaders never trust a client-supplied `appId`.
- **Active App is the URL** (`/app/:appId/...`). The loader checks the session has access to `:appId` or
  returns 403. Switching App is a navigation.

**Deferred (product decision):** what _issues_ the session — email/password, OAuth/SSO, magic link. The
`cookie → server validation → loader context` seam holds regardless of issuer; the issuer plugs in behind
it.

## Query keys and the nudge → invalidation mapping

ADR-0019's live-update model only works if there is a deterministic, shared mapping from a nudge
`{entity, id}` to the exact cache keys it must invalidate. That mapping is a **query-key factory** — one
module, the single source of truth for key shapes — and the WebSocket handler invalidates _through_ it,
never by hand-assembling key arrays.

- **Entity-rooted hierarchical keys** under the spine: `['app', appId, 'experiment', expId, ...]`. The
  factory exposes `keys.experiment.detail / .list / .runs`, etc. Components and loaders both construct keys
  only through the factory.
- **Invalidate by prefix.** A nudge for `experiment/abc` invalidates the `['app', appId, 'experiment']`
  prefix, catching list + detail + sub-resources in one call — no enumerating every dependent key.
- **Version-gated against self-edits.** The nudge carries `version` (ADR-0019). A client whose cached
  version is already ≥ the nudge's skips the refetch — so the editor who just wrote the change (and got the
  new version on its 200) treats the echoed nudge as a no-op; other editors refetch.

The factory is domain-aware → it lives in the panel app, not `ui`.

## WebSocket lifecycle

- **Owned by the `/app/:appId` layout route**, one socket per tab per App — matching the per-App DO grain.
  It persists across child navigations (experiments → flags → runs) because the layout route does not
  unmount; it tears down / reconnects only when `appId` changes or the tab closes.
- **Client-only, attaches after hydration** (ADR-0019). The loader runs server-side with no socket; the
  socket attaches in a client effect at layout mount.
- **Connect and reconnect both trigger a full invalidate-and-refetch.** This closes the sub-second gap
  between loader-seeded paint and socket connect (a nudge missed in that window self-heals on connect) and
  is the same free reconnect recovery ADR-0019 describes — no delta-replay log, no last-seen-version
  bookkeeping. The socket's first action is "assume I missed something, refetch."

## Error and loading conventions

Three tiers, at fixed levels of the route tree. The visual components (error pages, empty states,
skeletons) live in `ui` (they are brand surfaces); _which boundary catches what_ is panel routing config.

1. **Root error boundary** (app shell) — catastrophic / unexpected failures. The "something broke" page.
2. **Segment error boundaries** (`/app/:appId` layout and major sections) — _expected_ domain failures:
   403 → "you don't have access to this App," 404 → "experiment not found." Designed states, not stack
   traces.
3. **Failed background refetch** (the nudge path) — **non-fatal**. A failed nudge-refetch never unmounts
   good data; it degrades to a stale-with-toast state ("couldn't refresh, retrying"). This is the rule that
   makes the live-update model feel solid instead of flickery.

**Pending UI** via route `pendingComponent` / Suspense with `ui` skeletons. Loader-seeded routes have no
initial spinner (data is already there); client navigations to not-yet-loaded routes show skeletons.

## Observability (Sentry + Axiom)

Sentry severity tracks the error tier — expected states never page anyone.

- **Root + segment boundaries** → reported to Sentry with route, `appId`, `userId` context. Real defects,
  fail loud.
- **Expected domain failures (403/404)** → **not** Sentry errors. Normal control flow; logging them poisons
  the signal. At most a breadcrumb.
- **Failed background refetch** → low-severity breadcrumb, not a page-breaking error. A _pattern_ of them
  (read API down) is worth surfacing; one blip is not.

**Distributed tracing across the hops that matter:** trace context propagates SSR-loader → read-API and
client-fetch → read-API, so a panel error and its backend cause are one trace. User/App context
(`userId`, `appId`, `role`) is set once at the session-validation seam, so every downstream Sentry event —
server and client — is already tagged.

**Privacy (fail-loud rule):** the Targeting Key and Evaluation Context attributes can carry the customer's
end-user PII. They are **scrubbed from Sentry payloads.**

## Data flow: reads and mutations

ADR-0019 is explicit — the client never applies deltas; it invalidates and refetches truth, and config is
persisted-before-announced (the per-App DO validates, commits KV/D1, _then_ broadcasts).

The frontend mirrors that discipline: **server-confirmed mutations, no optimistic cache writes.**

- A config edit POSTs to the read/write API → through the DO → commit → broadcast → every client (including
  the writer) invalidates and refetches. The UI **always** shows persisted state and can never display an
  edit that failed validation. The writer's own 200 already carries the new version; the echoed nudge is a
  no-op (version gate). The nudge is what updates _other_ editors.
- **Form-level state is ephemeral `useState`** — typing in an edit form is local UI state; only _committed_
  config is ever written to the Query cache, and only by refetch.
- **Validation is the DO's, surfaced to the form.** The DO is the authoritative gate; a rejected write
  returns a structured error the form renders inline. The panel may add cheap client-side hints but never
  duplicates the authoritative validation — one source of validation truth.

## Deliberately not decided here

- **Session issuer** (email/password vs SSO vs magic link) — product decision; the seam is issuer-agnostic.
- **Screens / information architecture** — this is the architecture spec, not the UX spec.
- **Brand token _values_** — coming in the branding guide; this document pins _where_ tokens live, not what
  they are.
- **Marketing's live-data touchpoints** (pricing, status) — ADR-0020 routes them through the same Query
  store; specifics are a marketing-spec concern.
