# Human setup — the things an agent can't do for you

This is the single source of truth for **human blockers**: setup that an autonomous agent
cannot complete on its own. It exists so you do this **once**, record the outcome here, and
never re-derive it.

A blocker lands here only if a human must act. If an authenticated CLI clears it
(`wrangler`, `tb`, `gh`, etc.), it is **agent-doable** and lives in
[deployment-pipeline.md](./platform/deployment-pipeline.md), not here. The line is:
_can a CLI you've already logged into finish this?_ If yes, it's not a human blocker.

The three categories:

- **🔴 Active** — needed now, blocks the spine, and no CLI clears it.
- **⏸ Waiting on external** — blocked on a third party, not on us. Parked, not forgotten.
- **🟡 Decide later** — an open product/policy choice with no command to run. Deferred on purpose.
- **✅ Done** — recorded so we don't re-litigate it.

> **How to use this doc:** when you clear an item, change its status, fill in the **Recorded**
> block (IDs, dates, where the secret lives — never the secret value), and move on. Convert
> absolute dates, never relative.

---

## Status board

| #   | Item                                                        | Category              | Unblocks                             |
| --- | ----------------------------------------------------------- | --------------------- | ------------------------------------ |
| 1   | Seed `trusted_idps` (Anthropic / OpenAI / Cursor)           | ⏸ Waiting on external | Agent auth (ID-JAG, Door A)          |
| 2   | WorkOS app: register, redirect URLs, publish PRM/JWKS       | 🔴 Active             | All human + panel login              |
| 3   | Cloudflare Turnstile widget (site key + secret)             | 🔴 Active             | Safe anonymous registration (Door B) |
| 4   | Production domains + DNS (`splitch.dev`)                    | ✅ Done               | Production routes / public URLs      |
| 5   | GitHub `production` environment: required reviewers         | 🔴 Active             | Production deploy approval gate      |
| 6   | Blacksmith GitHub App                                       | ✅ Done               | CI on Blacksmith runners             |
| 7   | Stripe billing integration                                  | 🟡 Decide later       | Paid plans / `stripe_*` columns      |
| 8   | Compliance baseline (CCPA delete/export/opt-out at launch?) | 🟡 Decide later       | Privacy lifecycle scope              |
| 9   | Tenant-isolation upgrade trigger (app-enforced → DB RLS)    | 🟡 Decide later       | Isolation architecture at scale      |
| 10  | Attention-card numeric thresholds                           | 🟡 Decide later       | Panel tuning (ship-then-tune)        |
| 11  | Provisional-Org → real-account conversion UX                | 🟡 Decide later       | Onboarding upgrade flow              |

Everything else the spec calls "not provisioned" (Cloudflare resources, Tinybird Cloud +
`shared_preview` branch, secret storage via `wrangler secret` / `gh secret`, Turborepo remote
cache, Sentry/Axiom token storage) is **agent-doable with an authenticated CLI** and tracked in
[deployment-pipeline.md](./platform/deployment-pipeline.md). It is real work; it is not a human
blocker. The only human input those need is a **value that comes from an item above** (a WorkOS
secret, a Turnstile secret, a vendor token).

---

## 🔴 Active

### 2. WorkOS app: register, redirect URLs, publish PRM/JWKS

**Why human:** WorkOS app registration and AuthKit config are console-driven; redirect/callback
URLs depend on your real domains; the published OAuth Protected Resource Metadata + JWKS is config
a person sets. A CLI can store the resulting secret, not create the app relationship.

**Spec sources:** [auth-doors.md:42](./control-plane/auth-doors.md),
[monorepo-and-toolchain.md:187](./platform/monorepo-and-toolchain.md),
[session-loader-isolation.md:95](./frontend/session-loader-isolation.md).
Background: [ADR-0022](../adr/0022-agent-and-human-auth-via-auth-md-one-principal-three-doors.md).

**Do once:**

1. Create the WorkOS application (AuthKit) in the WorkOS dashboard.
2. Add redirect/callback URLs for local, shared-preview, and production (depends on item 4).
3. Note the issuer, JWKS URI, and client ID; generate the API key.
4. Store the secret via CLI once you have it — agent can run:
   `wrangler secret put WORKOS_API_KEY` (per Worker that needs it) and
   `gh secret set WORKOS_API_KEY` (per environment).

**Recorded:** _(client ID: …, issuer: …, secret stored in: …, date: …)_

### 3. Cloudflare Turnstile widget (site key + secret)

**Why human:** Turnstile widget creation is dashboard-side. Without it, the anonymous
registration write surface (Door B — mints WorkOS users + D1 rows) has no bot defense.

**Spec sources:** [credentials-and-keys.md:135-137](./control-plane/credentials-and-keys.md),
[auth-doors.md:54-59](./control-plane/auth-doors.md).
Background: [ADR-0034](../adr/0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md).

**Do once:**

1. Create a Turnstile widget in the Cloudflare dashboard; capture the site key (public) and
   secret key.
2. Store the secret: `wrangler secret put TURNSTILE_SECRET` on the Worker serving
   `POST /agent/identity`.
3. Wire the site key into the registration UI/SDK as a public value.

**Recorded:** _(site key: …, secret stored in: …, date: …)_

### 4. Production domains + DNS (`splitch.dev`)

**Done.** `splitch.dev` is purchased and owned on Cloudflare, and the per-Worker hostname map is
fixed by **[ADR-0038](../adr/0038-public-hostnames-are-a-fixed-human-owned-subdomain-map.md)**
(human-owned; agents do not invent hostnames). What remains is agent-doable: route attachment in
`wrangler.jsonc` per Worker, derived from the ADR table.

The hostnames also feed the WorkOS redirect URLs (item 2) and the Client-Key origin allow-list —
take them from ADR-0038, not from a guess.

**Spec sources:** [deployment-pipeline.md:31](./platform/deployment-pipeline.md) (production
"routes/domains");
[ADR-0038](../adr/0038-public-hostnames-are-a-fixed-human-owned-subdomain-map.md) (canonical
hostname map).

**Recorded:** zone `splitch.dev` purchased on Cloudflare (confirmed 2026-06-21); hostname map
pinned in ADR-0038.

### 5. GitHub `production` environment: required reviewers

**Why human:** This is _deliberately_ human. The production approval gate's entire purpose is
that a designated person clicks approve. `gh` can create the environment; a human must be the
reviewer and must enable prevent-self-review.

**Spec sources:** [deployment-pipeline.md:219-220, 278](./platform/deployment-pipeline.md),
[agent-verification.md:40](./platform/agent-verification.md).

**Do once:**

1. `gh api` / repo settings: create the `production` environment.
2. Add required reviewers (the humans who approve releases).
3. Enable "prevent self-review."

**Recorded:** _(reviewers: …, prevent-self-review: on, date: …)_

---

## ⏸ Waiting on external

### 1. Seed `trusted_idps` (Anthropic / OpenAI / Cursor)

**Status: PAUSED — blocked on external `client_id`s.** ID-JAG (Door A, the agent-identity root)
cannot validate any agent assertion until the `trusted_idps` table holds each IdP's issuer URI,
JWKS URI, and client ID. The `client_id`s are gated by steps outside our control. Park here;
resume when they arrive.

**Spec sources:** [access-control-matrix.md:51](./control-plane/access-control-matrix.md)
("Seed rows: Anthropic, OpenAI, Cursor"),
[auth-doors.md:35-43](./control-plane/auth-doors.md) (validation reads `iss` → `trusted_idps`).

**When unblocked, do once:** insert one row per IdP (`iss`, `jwks_uri`, `client_id`) into the D1
`trusted_idps` table via the control-plane (Org-owner CRUD) or a seed migration. Then move this
to ✅.

**Recorded:** _(blocked since: 2026-06-21; waiting on: external client_id issuance; owner per IdP: …)_

---

## ✅ Done

### 6. Blacksmith GitHub App

**Installed.** Required so `runs-on: blacksmith-*` jobs aren't adopted by another repo's runners.

**Spec source:** [deployment-pipeline.md:48](./platform/deployment-pipeline.md).

**Recorded:** installed on the `splitch` repo (confirmed 2026-06-21).

---

## 🟡 Decide later

These have no command to run — someone has to make a call. The spec leaves each open on purpose;
none blocks the spine.

### 7. Stripe billing integration

`stripe_customer_id` / `stripe_subscription_id` columns exist but integration is deferred. Needs a
product decision (plan structure, per-Org vs per-App, trial policy) **before** the account/keys
matter. — [organization-and-membership.md:21-22](./control-plane/organization-and-membership.md)

### 8. Compliance baseline

Whether CCPA delete/export/opt-out ships at launch or is deferred. —
[privacy-data-lifecycle.md:6-11](./platform/privacy-data-lifecycle.md)

### 9. Tenant-isolation upgrade trigger

App-enforced scoping is the boundary now. The spec records the _conditions_ under which DB-enforced
RLS becomes mandatory (audit finding, compliance mandate, scale) but leaves the call to a human. —
[multi-tenant-isolation.md:116-124](./platform/multi-tenant-isolation.md)

### 10. Attention-card numeric thresholds

Thresholds (significance reached, horizon, multiple-rate, low-n) need real traffic to tune.
Ship-then-tune. — [screen-inventory.md:11-12](./frontend/screen-inventory.md)

### 11. Provisional-Org → real-account conversion UX

Deferred; onboarding works with provisional accounts first. —
[screen-inventory.md:295](./frontend/screen-inventory.md)

---

## Sources

- [platform/deployment-pipeline.md](./platform/deployment-pipeline.md) — the agent-doable
  provisioning + CI/CD surface (everything a logged-in CLI clears).
- [platform/agent-verification.md](./platform/agent-verification.md) — what local proofs do and
  do not cover; "not provisioned" list.
- [control-plane/auth-doors.md](./control-plane/auth-doors.md),
  [control-plane/access-control-matrix.md](./control-plane/access-control-matrix.md),
  [control-plane/credentials-and-keys.md](./control-plane/credentials-and-keys.md) — auth roots.
