# Config mutation flow: server-confirmed writes, validation, and form error surfacing

## Principle: no optimistic cache writes

The panel applies **zero** optimistic updates. Persisted domain data changes only after a successful
write and reread. The UI reflects server-confirmed state. This is the frontend mirror of
the "persisted-before-announced" contract in the DO (ADR-0019).

"Optimistic" is any update to Query cache state before the server has confirmed persistence.
Even a flag toggle that feels instant must wait for the DO 200 before the cache changes.

## Mutation path

```
1. User submits form
2. Panel POSTs to a TanStack Start server function
3. Server function authorizes an Environment-pinned delegation and calls the typed Control Plane SDK
4. Worker validates and persists the operation; config changes use the per-(App, Environment) DO
5a. On success: caller revalidates its route or invalidates and refetches its Query keys
5b. On 4xx: mutation caller surfaces structured error to the form; no cache change
6. Echoed nudge arrives: version gate skips refetch only if a versioned detail is already cached
7. Other editors' sockets receive nudge → their caches invalidate → they refetch
```

## On 200: immediate refetch, no wait for nudge

The mutation caller does not wait for the nudge to trigger a refetch. It immediately invalidates
and refetches after receiving success. `useFlagEditing` calls `router.invalidate()` because its
screen uses route-loader data; Query-backed callers invalidate the affected keys:

```
onSuccess: (data) => {
  queryClient.invalidateQueries({ queryKey: queryKeys.flag.prefix(appId, environmentId) })
}
```

This avoids a flicker: the editor sees updated state immediately after save, not after the roundtrip
of nudge → invalidate → refetch.

## Mutation response shape (200)

Responses are operation-specific resource shapes, not a generic `{ data, version }` wire envelope.
For example, `FlagConfigMutationResponseSchema` extends the config read shape:

```
FlagConfigMutationResponse {
  flagId, environmentId, version, enabled, availableVariantNames,
  targetingRules, rollout, experiment,
  approvalRequest: ApprovalRequest | null,
  next?: MutationNext
}
```

The SDK wraps this in its typed success result; panel server functions may project it further
(`FlagWriteResult` returns status and Approval Request data). A cached detail's `version` lets the
nudge handler skip an echo; route-loader-only data does not imply that cache entry exists.

## On 4xx: structured error, form renders inline

The Worker returns the canonical `ErrorResponse` discriminated union from `@splitch/contracts`:

```
ErrorResponse {
  code:    ErrorCode
  message: string
  details: object     // shape selected by code; always present
  outcome?: ErrorOutcome
}

// VALIDATION_ERROR details:
{ issues: Array<{ path: string[], message: string, code?: string }> }
```

HTTP status codes:

- `400` — validation failure (field or entity constraint violated)
- `409` — conflict (e.g. edit-version mismatch, optimistic lock)
- `403` — caller lacks App role required for the operation

`mutationErrorSurface` in `src/lib/shared/api.ts` maps `details.issues` to inline fields and keeps
Approval Request IDs, Policy contexts, frozen fields, and terminal dispositions actionable.
The panel may show cheap client-side hints
(Zod parse of the same schema) as UX feedback while typing, but the DO's `ErrorResponse` is the
authoritative source. Client-side hints must not duplicate domain decisions made by the Worker.

`APPROVAL_REVIEW_REQUIRED` is a 409 with a durable request ID. The panel reads that request, shows
its recorded diff, and only sends `approve_and_apply` after an explicit Confirm. It never inserts
an inline Review automatically on the first submit (`control-plane-flag-mutations.ts`).

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
