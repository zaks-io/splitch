# Session validation contract, loader context shape, and appId isolation boundary

## Cookie format and validation location

The panel Worker validates an HTTP-only session cookie on every SSR request before any loader runs.
Validation hits **Workers KV** (the `session:<token>` key caches the validated identity) not D1 on the
hot path. D1 is the system of record; KV is the edge replica written through on session creation/revoke.

Cookie: `Set-Cookie: __session=<opaque_token>; HttpOnly; Secure; SameSite=Lax; Path=/`

KV schema for cached session:

```
key:   session:<sha256(token)>
value: { userId: string, orgs: OrgMembership[], expiresAt: number }
ttl:   aligned to token expiry (max 24 h)
```

A user may belong to **multiple Orgs** (personal + enterprise siblings, ADR-0021); the session carries
all of them. There is **no single "current org"** in the cookie — the active Org is the `orgSlug` URL
segment (navigation-and-ia.md). The org switcher lists `orgs`; each App switcher lists only the active
Org's Apps.

`OrgMembership`:
| field | type | req | meaning |
|-----------|-----------------|-----|-------------------------------------------|
| `orgId` | string | yes | Org the user belongs to |
| `orgRole` | OrgRole | yes | `owner \| admin \| member` |
| `apps` | AppMembership[] | yes | Apps in this Org the user can access |

`AppMembership`:
| field | type | req | meaning |
|-----------|--------|-----|--------------------------------|
| `appId` | string | yes | App the user is a member of |
| `role` | AppRole| yes | `owner \| admin \| member \| viewer` |

`OrgRole`: `owner | admin | member`

Environments are **not** in the session — Environment access follows App access (a member of the App
sees all its Environments; per-Environment write gating is the Environment Policy, ADR-0029, enforced
at the control-plane commit seam, not at the session layer).

## Loader context shape

The TanStack Start server handler deserializes the cookie, fetches from KV, and injects a **loader
context** object available to every route loader:

```
LoaderContext {
  userId: string         // WorkOS user ID
  orgs:   OrgMembership[] // every Org (and its Apps) this user can access
}
```

No "current org/app/environment" field. The active Org, App, and Environment are always derived from
the URL segments (`orgSlug`/`appSlug`/`env`), resolved to IDs at the loader, never persisted in the
session.

## Isolation check (per-route loader)

The check is layered to match the URL spine `/{orgSlug}/{appSlug}/{env}/...`. Each layer runs before
any work and feeds the next:

```
function requireOrgAccess(ctx: LoaderContext, orgSlug: string): OrgMembership {
  const o = ctx.orgs.find(o => o.slug === orgSlug)   // slug→membership resolved here
  if (!o) throw redirect(403)
  return o
}

function requireAppAccess(org: OrgMembership, appSlug: string): AppMembership {
  const m = org.apps.find(a => a.slug === appSlug)
  if (!m) throw redirect(404)   // app does not exist *under this org* — the appId∈org invariant
  return m
}
```

**The `appId ∈ org` invariant** (ADR-0027): an App belongs to exactly one Org. A URL pairing an
`appSlug` with an `orgSlug` it does not belong to is a clean **404** (the app does not exist under that
org), never a silent org-switch. Environment access follows App access — a resolved `env` segment that
is not an Environment of this App is a 404; no separate membership check (Environment write-gating is
the Environment Policy at the commit seam, not a read-isolation check).

The loader **never trusts client-supplied IDs**: slugs come from the URL, are resolved to memberships
by these checks, and the resulting `AppMembership` (including `role`) is what child loaders receive.

**Failure contract:** a 403 from `requireOrgAccess`/`requireAppAccess` is a **designed state** (user
lacks membership, e.g. was removed from the Org/App, or navigated to a stale back-link). It MUST be
caught by the segment error boundary at the `/{orgSlug}/{appSlug}` layout — not the root boundary —
and must NOT generate a Sentry error (breadcrumb only). The `appId ∈ org` 404 is likewise a designed
state. See [error-loading-tiers.md](./error-loading-tiers.md).

## Session issuer (WorkOS session issuer rule)

The issuer behind the cookie is **WorkOS**:

- Self-serve: WorkOS AuthKit (email/password + social OAuth)
- Enterprise: WorkOS SSO/SCIM

The `cookie → KV validation → loader context` seam is issuer-agnostic. WorkOS plugs in at session
creation (it issues the token splitch stores in the cookie). The loader never calls WorkOS per-request.

## App/Org switch and browser history

Navigating back to a URL with a stale `orgSlug`/`appSlug` the user no longer has access to:

- Loader runs `requireOrgAccess` / `requireAppAccess` → fails → 403 (or 404 for an appId∉org pairing)
- Segment boundary renders "you don't have access" / "not found"
- Session remains valid; user can navigate to any Org/App they do have access to
- No redirect to "last accessible app" (avoids session state)

## Query cache purge on App or Environment change

When `(appId, environmentId)` changes (App switch or Environment switch):

```
queryClient.invalidateQueries({ queryKey: ['app', previousAppId, 'env', previousEnvId] })
```

This must run before the new scope's loader seeds the cache, preventing stale entries from bleeding
across Apps or Environments. The layout route effect owns this call on `(appId, environmentId)` change.
See [appid-is-the-spine.md](./appid-is-the-spine.md).

## Sources

- [ADR-0018](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [ADR-0021](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0020](../../adr/0020-tanstack-start-for-both-control-panel-and-marketing-shared-component-layer.md)
- [navigation-and-ia.md](./navigation-and-ia.md)
- [frontend-architecture.md](../../architecture/frontend-architecture.md)
- WorkOS session issuer rule (WorkOS as session issuer)
