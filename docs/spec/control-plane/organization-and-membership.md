# Organization and Membership: entity shapes and D1 schema

Pins the Organization tier, App ownership, membership roles, and the D1 table shapes that back them.

## Organization

Every account is an Organization. Personal orgs are single-member. Enterprise orgs are multi-member
sibling Organizations of the same shape with SSO/SCIM enabled. No nullable org_id anywhere — the
personal-org path exercises the same code as enterprise from day one (no-superposition principle).

WorkOS owns authentication and the org's identity machinery. D1 owns authorization: what an
authenticated principal can touch lives here, not in WorkOS org claims.

### D1: `organizations` table

| column                   | type    | required | meaning                                                               |
| ------------------------ | ------- | -------- | --------------------------------------------------------------------- |
| `org_id`                 | TEXT PK | yes      | WorkOS Organization ID (wos prefix); stable across all ops            |
| `name`                   | TEXT    | yes      | Display name                                                          |
| `plan`                   | TEXT    | yes      | `free` \| `pro` \| `enterprise`; defaults to `free`                   |
| `stripe_customer_id`     | TEXT    | no       | Null until billing seam is wired; seam exists, integration deferred   |
| `stripe_subscription_id` | TEXT    | no       | Same — billing seam shape, live integration deferred                  |
| `sso_enabled`            | INTEGER | yes      | 0 \| 1 boolean; true only for enterprise orgs with WorkOS SSO wired   |
| `is_provisional`         | INTEGER | yes      | 0 \| 1; true while this Org was created by anon door, not yet claimed |
| `demo_expires_at`        | TEXT    | no       | ISO 8601; set on anon create; cleared on successful claim ceremony    |
| `created_at`             | TEXT    | yes      | ISO 8601                                                              |
| `updated_at`             | TEXT    | yes      | ISO 8601                                                              |

**Invariants:**

- `is_provisional = 1` implies `demo_expires_at IS NOT NULL`
- Reaper checks `is_provisional = 1 AND demo_expires_at < now()` (see [auth-doors.md](auth-doors.md))
- `plan` defaults to `free`; billing seam owns transitions

## App

An App is a product/service surface; it belongs to exactly one Organization. The `app_id` is the
isolation boundary for all data in D1 and Tinybird.

### D1: `apps` table

| column       | type    | required | meaning                                                  |
| ------------ | ------- | -------- | -------------------------------------------------------- |
| `app_id`     | TEXT PK | yes      | Splitch-generated, stable identifier (e.g. `app_<ulid>`) |
| `org_id`     | TEXT FK | yes      | Owner Organization; never nullable                       |
| `name`       | TEXT    | yes      | Display name; must be unique within the Org              |
| `created_at` | TEXT    | yes      | ISO 8601                                                 |
| `updated_at` | TEXT    | yes      | ISO 8601                                                 |

**Invariants:**

- `org_id` is never null; every App has exactly one Organization
- App deletion cascades or blocks depending on running Run state (policy: block if running Experiments)

## Org Membership

Org membership controls who can manage the Organization itself (billing, SSO config, create/delete Apps).

### D1: `org_memberships` table

| column       | type    | required | meaning                                    |
| ------------ | ------- | -------- | ------------------------------------------ |
| `org_id`     | TEXT FK | yes      | Organization; composite PK with `user_id`  |
| `user_id`    | TEXT FK | yes      | WorkOS User ID; composite PK with `org_id` |
| `role`       | TEXT    | yes      | `owner` \| `admin` \| `member`             |
| `created_at` | TEXT    | yes      | ISO 8601                                   |

**Role matrix (Org scope):**

| operation           | owner | admin | member |
| ------------------- | ----- | ----- | ------ |
| Manage billing/plan | yes   | no    | no     |
| Configure SSO/SCIM  | yes   | yes   | no     |
| Create/delete Apps  | yes   | yes   | no     |
| Manage Org members  | yes   | yes   | no     |
| View Org settings   | yes   | yes   | yes    |
| Manage trusted IdPs | yes   | no    | no     |

Control Panel App creation stays server-side. The Panel validates its opaque session cookie, sends
only the session's SHA-256 handle over the Control Plane service binding, and never exposes that
handle to browser code. The Control Plane resolves the live session actor from shared session KV;
the `apps_create` handler then applies the owner/admin matrix above from D1. Cached Panel roles do
not authorize the mutation, and Worker refusals remain the typed response returned to the Panel.

## App Membership

App membership controls who can read/write Flag, Experiment, and Run config for a specific App.

### D1: `app_memberships` table

| column       | type    | required | meaning                                    |
| ------------ | ------- | -------- | ------------------------------------------ |
| `app_id`     | TEXT FK | yes      | App; composite PK with `user_id`           |
| `user_id`    | TEXT FK | yes      | WorkOS User ID; composite PK with `app_id` |
| `role`       | TEXT    | yes      | `owner` \| `admin` \| `member`             |
| `created_at` | TEXT    | yes      | ISO 8601                                   |

**Role matrix (App scope):**

| operation                       | owner | admin | member |
| ------------------------------- | ----- | ----- | ------ |
| Start/end Experiment Runs       | yes   | yes   | no     |
| Edit Flags/Experiments (draft)  | yes   | yes   | yes    |
| Promote Flag Config across Envs | yes   | yes   | no     |
| Edit Environment Policy         | yes   | yes   | no     |
| Manage SDK credentials          | yes   | yes   | no     |
| View config/results             | yes   | yes   | yes    |
| Delete Flags/Experiments        | yes   | no    | no     |

Roles are still App/Org level (not per-Environment). Promotion (moving Flag Configuration between
Environments, ADR-0028) and Environment Policy edits are additionally gated by the per-change-type
confirmation gates of the target Environment's Policy (ADR-0029): a permitted role may still have to
satisfy a confirm gate before an Environment-level write commits.

## User entity

Users are identified by their WorkOS User ID. Persistent across all three identity doors. The
shared-preview `client_credentials` grant resolves to a configured seeded WorkOS user, not a separate
principal class. No separate splitch user table for user-data — user attributes (email, display name)
are resolved from the WorkOS session token at login and cached in the control-plane token's claims;
D1 stores only the `user_id` foreign key in membership tables.

## Isolation seam

Every D1 query is routed through the single repository/data-access seam. No code path queries D1
bypassing it. `app_id` is the required scope param on every non-Org query. See
[d1-and-tinybird-data-access.md](d1-and-tinybird-data-access.md) for the seam contract.

## Sources

- [../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md](../../adr/0021-organization-is-the-account-tier-above-app-personal-orgs-enterprise-as-siblings.md)
- [../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md](../../adr/0018-identity-and-operational-state-in-d1-hot-validation-in-kv-audit-in-tinybird.md)
- [../../adr/0027-environment-is-a-first-class-axis-under-app.md](../../adr/0027-environment-is-a-first-class-axis-under-app.md)
- [../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md](../../adr/0028-variant-catalog-is-app-level-availability-is-per-environment-promotion-moves-config.md)
- [../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md](../../adr/0029-environment-policy-configurable-per-change-type-confirmation-gates.md)
