# Control-plane live updates over hibernating WebSocket; delta-nudge + TanStack Query as the store

**Status:** accepted

ADR-0017 said a Durable Object fans out live config updates "(SSE/WebSocket)" to subscribed
dashboards but left the slash unresolved. This ADR resolves it: the control-panel live-update
transport is a **Hibernating WebSocket** served by **one fan-out DO per App** (`idFromName(appId)`);
config writes go **through that DO** (it commits the KV/D1 write, then broadcasts); the broadcast is a
small **delta-shaped invalidation signal**, not the config body; and the client applies nothing —
**TanStack Query is the sole synced server-state store**, and the signal just invalidates a query key
so the client refetches truth from the normal read API.

This deliberately **reverses the intuition that started the design** ("use HTTPS streaming, avoid a
long-lived WebSocket"). On Cloudflare both SSE and WebSocket hold a long connection — that is
inherent to push — but only **WebSocket has DO Hibernation**: while a hibernating WebSocket is idle,
the DO evicts from memory and **billable Duration (GB-s) stops accruing**, with the edge still holding
the socket and re-waking the DO on the next message. SSE is a long-lived HTTP response held open
inside a `fetch` handler, which keeps the DO **resident and billing for the whole connection**, idle
or not — there is no SSE hibernation. So the connection-cost worry that motivated "not WebSocket" is
in fact *worse* for SSE on this stack; hibernating WebSocket is the cheap option, not the expensive
one. (`https://developers.cloudflare.com/durable-objects/best-practices/websockets/`.)

## Scope

Live updates carry **config / operational state changes** under an App — a Flag or Experiment edited
by another editor, a Run starting or ending, enabled/disabled and status transitions — sourced from
the KV/D1 config store. **Not** live experiment statistics (Exposure counts, p-values, CIs, SRM):
those live in Tinybird, which ADR-0017 explicitly kept off the live-UI path. Streaming analytics is a
separate problem with a separate mechanism and is out of scope here.

## Decisions

- **Transport: Hibernating WebSocket** (DO Hibernation API), for the billing reason above. Resolves
  ADR-0017's `SSE/WebSocket` slash.
- **Fan-out grain: one DO per App** (`idFromName(appId)`). The App is the blast radius (D1
  membership/roles, ADR-0018) and the audience is single-digit editors (ADR-0017), so per-App
  fan-out is a handful of sockets per DO that hibernates whenever nobody is editing. A socket
  authenticated to App X can attach only to `DO(X)`, so the `app_id` application-enforced isolation of
  ADR-0018 extends cleanly to "which DO you may connect to."
- **Notify path: write-through-the-DO.** The config-write Worker calls `DO(appId)`, which validates,
  commits the KV/D1 write, *then* broadcasts. The DO is the single serialization point for write and
  notify, so a broadcast can never describe unpersisted state (**persisted-before-announced**). This
  reuses ADR-0009's shape verbatim — a per-key DO serializing a write that write-throughs to KV — so
  config and the hot path share one mental model. (Consequence: the DO wakes on every config write
  because it *is* the writer; config writes are rare human clicks, so it re-hibernates immediately.)
- **Payload + client state: delta-shaped nudge, Query-as-store.** The broadcast names the changed
  entity (e.g. `{type:"config.changed", entity:"experiment", id, version}`) — small, so fan-out is
  cheap and the DO never learns the config schema. The client does **not** apply the delta; it
  invalidates that TanStack Query key and refetches the authoritative state from the read API. The
  **TanStack Query cache is the only synced server-state store** (no Redux/Zustand — a second copy of
  state to reconcile is exactly the weight being avoided); `useState`/local holds only ephemeral UI
  state. **The socket is never the source of truth — it is a "something changed, go look" nudge**, and
  the panel reads config the same way whether nudged or freshly loaded, honoring ADR-0017's "same
  store, no publish seam." Under **TanStack Start**, the route's server loader seeds the Query cache
  for a correct first paint; the WebSocket attaches only after hydration (it is client-only) and from
  then on drives invalidations. **Reconnect recovery is free**: on reconnect the client invalidates and
  refetches — the same path the loader already runs — so a missed broadcast during a reconnect window
  self-heals with no delta-replay log or last-seen-version bookkeeping.

## Considered options

- **SSE / HTTPS streaming** — rejected. No DO hibernation, so the DO stays resident and billing for
  the full duration a panel is open, idle or not. Its real advantages (no upgrade handshake,
  `EventSource` auto-reconnect, curl-debuggable) do not outweigh paying wall-clock to hold idle panels
  open, given the hibernation gap is the whole cost question.
- **Polling, no push** — rejected as the primary mechanism. It would delete the DO fan-out (the one
  net-new piece ADR-0017 named), but config edits by a collaborator would surface only on the next
  poll, and "real-time control panel" is the stated goal. (Polling remains the trivial fallback if the
  socket is down — it is just the refetch on a timer.)
- **Full-state push over the socket** — rejected. Couples the DO to the config schema, bloats fan-out
  messages, and still needs a snapshot on reconnect (which is a refetch anyway). The delta-nudge gets
  small messages *and* a trivial reconnect story.
- **Versioned delta log with client-side replay** (client applies patches to a local normalized
  store, asks `getSince(version)` on reconnect) — rejected as over-built for a single-digit-editor,
  low-volume surface. It is correct and minimal-reads at scale, but it reintroduces ordering, log
  retention, replay, and a second source of truth to reconcile — the Redux-weight client store this
  design exists to avoid. Reconsider only if the control plane becomes genuinely collaborative
  (live multi-editor, presence, optimistic concurrency) — the same threshold ADR-0017 set for
  reconsidering Convex.

## Consequences

- **ADR-0017's `SSE/WebSocket` slash is resolved to WebSocket**, on a billing argument specific to DO
  hibernation. Anyone who reads "avoid long-lived connections" into the choice should read this ADR:
  the long connection is unavoidable for push, and the hibernating one is the cheap one.
- **The per-App fan-out DO is the only net-new server piece**, exactly as ADR-0017 forecast — now
  pinned to a concrete shape (per-App, write-through, delta-broadcast) that mirrors ADR-0009.
- **No client state-management platform is added.** TanStack Query (already in the stack) is the store;
  the WebSocket replaces a polling timer, nothing more.
- **No config-publish seam is introduced** (ADR-0017 consequence preserved): the panel always reads
  config from the same store the hot path reads; the socket only changes *when* it refetches.
