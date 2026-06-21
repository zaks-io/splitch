# Navigation & information architecture

## Scope roots in the URL

Three scope segments, all in the URL, never in hidden session state:

```
/{orgSlug}/{appSlug}/{env}/{section}/{...}
```

- **`orgSlug`** — the org you are currently logged into. You see only this org's Apps.
  Switching orgs is an explicit navigation via the **org switcher**, which changes `orgSlug`
  and lands you on that org's App list. Apps are **never merged across orgs** in any list.
- **`appSlug`** — the active App, the spine (see [appid-is-the-spine.md](./appid-is-the-spine.md)).
- **`env`** — the active Environment (dev, prod, …), changed via the **environment switcher**
  (ADR-0027). Per-Environment Flag Configuration, experiments, and data hang off this segment.

`orgSlug`/`appSlug`/`env` are **human/agent-readable handles only** — resolved to `orgId`/`appId`/
`environment_id` once at the loader; everything below speaks IDs, and no cache, DO, or data lookup is
ever keyed on a slug. (There is no `/app/` path prefix — the two bare slugs are unambiguous, GitHub's
`/{org}/{repo}` shape.)

Both roots follow the same discipline: scope lives in the URL so a pasted link is unambiguous
and renders identically for any recipient with access. There is no "current org" cookie field
that a link could disagree with.

### Invariant: appId belongs to orgSlug

`appId` resolves server-side to exactly one org. A request where `{appId}` does not belong to
`{orgSlug}` is a contradiction, not a silent redirect: the loader rejects it (404 — the app does
not exist _under this org_), rather than switching the user's org out from under them.

## The three switchers

- **Org switcher** — present only for users in more than one org. Changes `orgSlug`. A
  single-org user (the common self-serve case, a personal Organization) never sees it.
- **App switcher** — lists Apps within the **current org only**. Changes `appSlug`.
- **Environment switcher** — lists the active App's Environments. Changes `env`. Always present
  (every App has at least a `prod` Environment).

## Sidebar: scoped to the active App + Environment

A persistent left sidebar, scoped to `/{orgSlug}/{appSlug}/{env}`, with sections mapping 1:1 to the
App's first-class children plus settings:

- **Flags** — definition (App-level catalog) + the active Environment's Flag Configuration
- **Experiments** — scoped to the active Environment
- **Segments** — App-level (usable in any Environment)
- **Metrics** — App-level (definitions usable in any Environment)
- **Settings** — App config + per-Environment settings: the active Environment's SDK keys
  (Client/API), its **Environment Policy** (confirm gates), and Environment management

Org-level concerns (members, billing, the App list itself) live at the org root, one level up
from any App. Environment-scoped concerns (keys, Policy) live under the active `env`.

## Why org is in the URL (not session state)

The user asked for an "active org" UX: see only the current org's Apps, switch via a switcher.
That UX is achievable two ways — org in the URL, or org as a session/cookie field. We put it in
the URL because:

- An `appId` already resolves to exactly one org. With org in the URL, a link carries its own
  scope and the appId/org pair is either consistent or a clean 404 — never an ambiguous
  "switch your active org silently or 403" decision.
- It is the same no-hidden-state discipline already chosen for `appId`. Adding a _second_
  ambient "current org" cookie would reintroduce exactly the drift the spine principle rejects.

## Reconciled

The spine and session docs are reconciled to this IA:

- [appid-is-the-spine.md](./appid-is-the-spine.md) — `(appId, environmentId)` co-spine; slugs resolve
  to IDs at the loader; DO/cache/socket keyed by the pair.
- [session-loader-isolation.md](./session-loader-isolation.md) — multi-org cookie (`orgs[]`, no current
  org), layered `requireOrgAccess`→`requireAppAccess`, and the `appId ∈ org` 404 invariant.

## Sources

- [ADR-0021](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [ADR-0027](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [ADR-0029](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
