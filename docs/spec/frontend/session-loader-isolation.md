# Session validation contract, loader context shape, and appId isolation boundary

## Cookie format and validation location

The panel Worker validates an HTTP-only session cookie on every SSR request before any loader runs.
Validation hits **Workers KV** (the `session:<token>` key caches the validated identity) not D1 on the
hot path. D1 is the system of record; KV is the edge replica written through on session creation/revoke.

Cookie: `Set-Cookie: __session=<opaque_token>; HttpOnly; Secure; SameSite=Lax; Path=/`

KV schema for cached session:
```
key:   session:<sha256(token)>
value: { userId: string, orgId: string, memberships: AppMembership[], role: OrgRole, expiresAt: number }
ttl:   aligned to token expiry (max 24 h)
```

`AppMembership`:
| field     | type   | req | meaning                        |
|-----------|--------|-----|--------------------------------|
| `appId`   | string | yes | App the user is a member of    |
| `role`    | AppRole| yes | `owner \| admin \| member \| viewer` |

`OrgRole`: `owner | admin | member`

## Loader context shape

The TanStack Start server handler deserializes the cookie, fetches from KV, and injects a **loader
context** object available to every route loader:

```
LoaderContext {
  userId:      string          // WorkOS user ID
  orgId:       string          // WorkOS organization ID
  memberships: AppMembership[] // all Apps this user can access
  orgRole:     OrgRole
}
```

No `appId` or "current app" field. The active App is always derived from the URL param, never
persisted in the session.

## appId isolation check (per-route loader)

Every route loader under `/app/:appId/` MUST perform the membership check before doing any work:

```
function requireAppAccess(ctx: LoaderContext, appId: string): AppMembership {
  const m = ctx.memberships.find(m => m.appId === appId)
  if (!m) throw redirect(403)           // structured 403, not an exception
  return m                              // { appId, role } used by child loaders
}
```

The loader **never trusts a client-supplied `appId`**: the `appId` comes from the URL param validated
by this check, and the resulting `AppMembership` (including `role`) is what child loaders receive.

**Failure contract:** a 403 from `requireAppAccess` is a **designed state** (user lacks membership,
e.g. was removed from the App, or navigated to a stale back-link). It MUST be caught by the segment
error boundary at the `/app/:appId` layout — not the root boundary — and must NOT generate a Sentry
error (breadcrumb only). See [error-loading-tiers.md](./error-loading-tiers.md).

## Session issuer (WorkOS session issuer rule)

The issuer behind the cookie is **WorkOS**:
- Self-serve: WorkOS AuthKit (email/password + social OAuth)
- Enterprise: WorkOS SSO/SCIM

The `cookie → KV validation → loader context` seam is issuer-agnostic. WorkOS plugs in at session
creation (it issues the token splitch stores in the cookie). The loader never calls WorkOS per-request.

## App switch and browser history

Navigating back to a URL with a stale `appId` the user no longer has access to:
- Loader runs `requireAppAccess` → fails → returns 403
- Segment boundary renders "you don't have access to this App"
- Session remains valid; user can navigate to any App they do have access to
- No redirect to "last accessible app" (avoids session state)

## Query cache purge on App change

When `appId` changes (user navigates from `/app/A/...` to `/app/B/...`):

```
queryClient.invalidateQueries({ queryKey: ['app', previousAppId] })
```

This must run before the new App's loader seeds the cache, preventing stale entries from App A
bleeding into App B's views. The layout route effect owns this call on `appId` change.

## Sources

- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
- WorkOS session issuer rule (WorkOS as session issuer)
