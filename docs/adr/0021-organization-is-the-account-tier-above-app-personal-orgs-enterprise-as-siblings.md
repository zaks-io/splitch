# Organization is the account/ownership tier above App; personal orgs for self-serve, enterprise as additive siblings

**Status:** accepted

splitch introduces a new domain tier, the **Organization**, sitting _above_ the App. It is the
**account / ownership / billing / membership unit**: an Organization owns one or more Apps and has Users
as members (with roles). This is distinct from the App, which is a **product / service surface** (the five
runtimes of one product share one App — CONTEXT.md, ADR-0017). An App is _not_ an ownership unit; the
Organization is. Conflating the two would reintroduce the exact "Site / Workspace / Tenant" confusion the
glossary was built to prevent.

**Every account is an Organization, always — there is no null/standalone-App case.** Self-serve signups get
a **personal Organization** (the standard SaaS shape: your account _is_ a one-member org that happens to be
called "you"). **Enterprise** accounts are **sibling Organizations of the same shape** that additionally
carry SSO/SCIM. Because the org tier is _always present and always exercised_ — the default personal-org path
runs through the same Organization-resolution code an enterprise org will — there is no dormant, untested
branch that only lights up for the first (and most important) enterprise customer. This is the
no-superposition principle applied to the data model: the code never asks "does this App have an owner or
not"; every App belongs to exactly one Organization.

**Authorization stays in D1; WorkOS owns authentication and the org tier's identity machinery.** ADR-0018
already made D1 the system of record for App membership + roles, with the `app_id` data-access seam as the
isolation boundary. That is unchanged. The Organization is adopted **verbatim from WorkOS** (where it
physically lives on the identity side), but splitch resolves _what an authenticated principal can touch_
(Apps, roles) from D1, not from WorkOS org claims. WorkOS proves _who you are_; D1 says _what you own_.

**Enterprise onboarding is therefore an additive feature, not a rewrite.** Adopting SSO/SCIM later is
`create a new sibling Organization` + wiring the WorkOS SSO/SCIM intake to _that_ org — zero change to the
default personal-org path, the App model, or the `app_id` seam. This honors the production-ready-progressive
principle: the deferred feature (enterprise) drops onto a tier that already exists, rather than forcing a
tenancy migration.

## Considered options

- **App _is_ the top-level unit; no Organization tier (the pre-this-ADR model)** — rejected. There is no
  home for billing, multi-App ownership, or enterprise membership; "who owns this App and who's on the team"
  has nowhere to live. Stretching App to mean both product and account is the Site/Workspace/Tenant
  conflation the glossary forbids.
- **One shared global "splitch" Organization everyone joins** — rejected. It forces self-serve isolation to
  work _differently_ from enterprise isolation (a shared org can't be the boundary, so only `app_id` is),
  reintroducing a special case. Per-account orgs make self-serve and enterprise structurally identical.
- **A nullable `org_id` on App (org tier present only sometimes)** — rejected as a superposition: the code
  would branch on "has an org or not," and the org path would be dead code until the first enterprise
  customer exercised it in production. Always-present personal orgs exercise the same path from day one.
- **WorkOS Organization as the live App-authz boundary now** — rejected: puts the tenant boundary in a third
  party before a single enterprise customer exists, contradicts ADR-0018's working D1 authz model, and taxes
  every self-serve user with org-reconciliation logic they don't need. WorkOS stays in its lane
  (authentication + the org's identity machinery); D1 stays the authz authority. Revisit only when enterprise
  SSO/SCIM is a committed, near-term requirement — at which point the sibling-org shape makes it additive.

## Consequences

- **CONTEXT.md gains a canonical term, Organization**, with App explicitly demoted to "product, not owner."
  The two are orthogonal: an Organization owns one-to-many Apps; an App belongs to exactly one Organization.
- **D1 gains the Organization tier** (Org, Org membership/roles, App→Org ownership). The `app_id` isolation
  seam (ADR-0018) is unchanged; Org sits above it.
- **The enterprise path is tested from day one** because personal orgs run the same resolution code.
- **WorkOS Organizations are not yet load-bearing for authz.** They become the physical home of the org tier
  when enterprise SSO/SCIM lands; until then WorkOS does authentication only. This pairs with the auth model
  in ADR-0022.
