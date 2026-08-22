# Navigation & information architecture

## Scope roots in the URL

The App home has two scope segments; every Environment-scoped destination has three. All scope is
in the URL, never in hidden session state:

```text
/{orgSlug}/{appSlug}                         App home: Flags across all Environments
/{orgSlug}/{appSlug}/{env}/{section}/{...}
```

- **`orgSlug`** — the org you are currently logged into. You see only this org's Apps.
  Switching orgs is an explicit navigation via the **org switcher**, which changes `orgSlug`
  and lands you on that org's App list. Apps are **never merged across orgs** in any list.
- **`appSlug`** — the active App, the spine (see [appid-is-the-spine.md](./appid-is-the-spine.md)).
- **`env`** — the active Environment (dev, prod, …), changed via the **environment switcher**
  (ADR-0027). It is absent only on the App home, which shows every Environment. Per-Environment
  Flag Configuration, experiments, and data hang off this segment.

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

## The sidebar

- **App switcher, top** — lists Apps within the **current Organization only**. Switching Apps lands
  on the target App home without inventing an Environment.
- **Environment pills, below the App** — list the active App's Environments and preserve the current
  path, query, and hash when `env` changes. They also render on the App home with no active pill;
  from there each opens that Environment's Flags list.
- **Organization switcher, bottom** — present only for users in more than one Organization. It
  changes `orgSlug` and lands on that Organization's App list. A single-Organization user sees the
  Organization name without a switcher.

## Sidebar: scoped to the active App + Environment

A persistent left sidebar wraps both Organization and App screens. When an App and Environment are
active, its sections map 1:1 to the App's first-class children plus settings, in this order:

- **Flags** — definition (App-level catalog) + the active Environment's Flag Configuration
- **Experiments** — scoped to the active Environment
- **Overview** — third in the operator-use order; the active Environment's attention dashboard
- **Segments** — App-level (usable in any Environment)
- **Metrics** — App-level (definitions usable in any Environment)
- **Settings** — App config + per-Environment settings: the active Environment's SDK keys
  (Client/API), its **Environment Policy** (confirm gates), and Environment management

The bottom Organization block remains visible from every authenticated screen. It contains the
Organization name or multi-Organization switcher, then Apps, Members, Billing & Usage, and the user
row with Sign out. Organization screens show the same shell without App sections or Environment
pills.

Org-level concerns live at the org root, one level up from any App, as three screens (detailed in
[screen-inventory.md](./screen-inventory.md)):

- `/{orgSlug}` — the **App list** (org landing); each App name links to the App home and each
  Environment links to its Overview.
- `/{orgSlug}/{appSlug}` — **Flags across all Environments**, the one Environment-less App URL.
- `/{orgSlug}/members` — **Org Members** (distinct from per-App membership, which lives under App
  Settings).
- `/{orgSlug}/billing` — **Billing & Usage** (Evaluation-quota usage is real v1; payment is the
  deferred stub, ADR-0033).

Environment-scoped concerns (keys, Policy) live under the active `env`.

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
