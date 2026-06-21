# Auth API context

Read this when touching `apps/auth-api` or auth-owned Organization and membership behavior.

## Owns

- Organization identity and membership language.
- User membership and role language.
- Auth-side ownership terms that map to WorkOS.

## Terms

**Organization**:
The account and ownership unit. It owns one or more Apps and has Users as members with roles. Every
account is an Organization: self-serve signups get a personal Organization; enterprise accounts are
sibling Organizations of the same shape that additionally carry SSO/SCIM. The term is adopted from
WorkOS, where the Organization physically lives on the identity side. Distinct from App:
Organization is organizational ownership, not a product.

Avoid: using App for this; Tenant; Workspace; Account.

**User**:
A human principal that can be a member of one or more Organizations. Users do not own Flags or
Experiments directly. Organization membership and role grants determine what a User can do.

**App**:
A product or service surface owned by exactly one Organization. Auth may authorize access to an App,
but App remains a control-plane product unit, not an auth account.

See [`../control-plane-api/CONTEXT.md`](../control-plane-api/CONTEXT.md) for App, Environment,
Policy, and credential terms.

## Relationships

- Organization owns Apps.
- Organization has Users as members.
- A personal Organization and an enterprise Organization use the same domain shape.
- App belongs to exactly one Organization.

## Ambiguities resolved here

- "Site" is not the ownership root. Use App only for the product surface.
- "Account" is not canonical in splitch. Use Organization.
- Enterprise is not a separate domain object. It is an Organization with SSO/SCIM behavior.
