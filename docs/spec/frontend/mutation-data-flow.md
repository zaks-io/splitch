# Config mutation flow: server-confirmed writes, validation, and form error surfacing

## Principle: no optimistic cache writes

The panel applies **zero** optimistic updates. A cache mutation happens only by refetch after a
server 200. The UI always reflects persisted, DO-validated state. This is the frontend mirror of
the "persisted-before-announced" contract in the DO (ADR-0019).

"Optimistic" is any update to Query cache state before the server has confirmed persistence.
Even a flag toggle that feels instant must wait for the DO 200 before the cache changes.

## Mutation path

```
1. User submits form
2. Mutation POSTs to control-plane read/write API
3. Worker routes request through per-(App, Environment) DO (idFromName(`${appId}:${environmentId}`))
4. DO validates → commits D1/KV → broadcasts nudge to all connected clients
5a. On 200: mutation caller triggers immediate refetch of the affected entity
5b. On 4xx: mutation caller surfaces structured error to the form; no cache change
6. Echoed nudge arrives: version gate skips refetch for the editor (version already current)
7. Other editors' sockets receive nudge → their caches invalidate → they refetch
```

## On 200: immediate refetch, no wait for nudge

The mutation caller does not wait for the nudge to trigger a refetch. It immediately invalidates
and refetches after receiving a 200, using the version from the 200 response:

```
onSuccess: (data) => {
  // data.version is the new version from the DO
  queryClient.invalidateQueries({ queryKey: keys[entity].prefix(appId, environmentId) })
  // The refetch result will carry data.version, so the echoed nudge is version-gated to a no-op
}
```

This avoids a flicker: the editor sees updated state immediately after save, not after the roundtrip
of nudge → invalidate → refetch.

## Mutation response shape (200)

The control-plane API returns the full updated entity on 200, including the new version:

```
MutationResponse<T> {
  data:    T         // full updated entity (Experiment, Flag, Metric, Segment, Run, ...)
  version: number    // monotone version for version-gating
}
```

The version is stored in the Query cache as part of the entity shape so the nudge handler can
compare against it. Entities served by the read API must carry `version` on their response shape.

## On 4xx: structured error, form renders inline

The DO returns validation errors as a structured response body:

```
ErrorResponse {
  code:    string                          // machine-readable e.g. 'VALIDATION_ERROR'
  message: string                          // human summary
  errors:  FieldError[]                    // field-level details (may be empty)
}

FieldError {
  field:   string    // dot-path e.g. 'allocation.controlVariant', 'name'
  code:    string    // e.g. 'REQUIRED', 'VARIANT_NOT_DEFINED', 'DUPLICATE_KEY'
  message: string    // human-readable hint
}
```

HTTP status codes:

- `400` — validation failure (field or entity constraint violated)
- `409` — conflict (e.g. edit-version mismatch, optimistic lock)
- `403` — caller lacks App role required for the operation

**The form renders `errors` inline, one per field.** The panel may show cheap client-side hints
(Zod parse of the same schema) as UX feedback while typing, but the DO's `ErrorResponse` is the
authoritative source. Client-side hints MUST NOT duplicate the DO's logic — they are cheap,
best-effort, and may diverge if the DO adds a new constraint.

## Form-level ephemeral state

Form inputs are `useState` — uncommitted edits are local component state. They are NEVER written
to the Query cache. The Query cache holds only server-confirmed, DO-persisted data.

When the form is submitted:

- Valid 200 → form state is cleared; Query cache is updated via refetch
- 4xx → form state is retained (user keeps their edits); errors are displayed inline

When the user abandons an edit (navigates away):

- Form state is discarded by component unmount; no cache write occurred

## Draft Run edits

Assignment-affecting edits accumulate on a draft. The mutation API for these
edits writes to the draft state, not the live Run. The form must clearly show "Draft — Start to
apply" when editing a running Experiment's assignment config. The draft state lives in D1 and is
returned as part of the Experiment detail shape; the Query cache carries it.

## Sources

- [ADR-0019](../../adr/0019-control-plane-live-updates-over-hibernating-websocket-delta-nudge-tanstack-query-store.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
