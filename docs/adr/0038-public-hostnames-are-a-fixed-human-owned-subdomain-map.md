# Public hostnames are a fixed, human-owned subdomain map

**Status:** accepted

splitch's public surface is served by several independent Workers. Where each one lives — its
hostname — is an identity, branding, and security decision, not an implementation detail. The
hostname feeds WorkOS redirect/callback URLs, the Client-Key origin allow-list, CORS, and the
`wrangler.jsonc` route table. If an implementing agent were to invent hostnames, it would scatter
guesses across all of those places and create churn the first time a human disagreed.

This ADR fixes the map once. The registered zone is **`splitch.dev`**, purchased and owned on
Cloudflare. Agents read this map; they do not choose hostnames.

## Decision

### 1. One subdomain per public surface on `splitch.dev`

Subdomain-per-surface (not path-based on the apex). Each public Worker gets its own host, which
keeps per-Worker routing, WAF rules, CORS, and the Client-Key origin allow-list cleanly separable.

| Worker                   | Workspace                    | Production host      | Public? |
| ------------------------ | ---------------------------- | -------------------- | ------- |
| Marketing Worker         | `@splitch/marketing`         | `splitch.dev` (apex) | yes     |
| Control Panel Worker     | `@splitch/control-panel`     | `app.splitch.dev`    | yes     |
| Control Plane API Worker | `@splitch/control-plane-api` | `api.splitch.dev`    | yes     |
| Auth API Worker          | `@splitch/auth-api`          | `auth.splitch.dev`   | yes     |
| Evaluation Worker        | `@splitch/evaluation-api`    | `edge.splitch.dev`   | yes     |
| Event Ingest Worker      | `@splitch/event-ingest-api`  | `ingest.splitch.dev` | yes     |
| MCP Worker               | `@splitch/mcp-server`        | `mcp.splitch.dev`    | yes     |
| Analysis Worker          | `@splitch/analysis-api`      | _none — internal_    | no      |

- `www.splitch.dev` redirects to the apex.
- The Analysis Worker has **no public hostname**. It is reached by service binding only, matching
  its binding rule in [deployment-pipeline.md](../spec/platform/deployment-pipeline.md) (no public
  evaluate/ingest bindings). Routes it implements that take a control-plane token are still
  addressed at `api.splitch.dev`: the Control Plane authorizes the caller and delegates over the
  binding ([ADR-0046](0046-a-routes-public-address-follows-its-credential-not-its-owner.md)). This
  table is keyed by hostname, not by which Worker executes a route.

### 2. Shared-preview hosts mirror the scheme under a `preview` label

Shared preview is one hosted target ([deployment-pipeline.md](../spec/platform/deployment-pipeline.md)).
Its hostnames mirror production with a `preview` segment so origin/CORS rules and WorkOS redirect
URLs are derivable, not improvised:

| Surface       | Shared-preview host          |
| ------------- | ---------------------------- |
| Marketing     | `preview.splitch.dev`        |
| Control Panel | `app.preview.splitch.dev`    |
| Control Plane | `api.preview.splitch.dev`    |
| Auth          | `auth.preview.splitch.dev`   |
| Evaluation    | `edge.preview.splitch.dev`   |
| Event Ingest  | `ingest.preview.splitch.dev` |
| MCP           | `mcp.preview.splitch.dev`    |

Local and `pr-ci` targets stay on `127.0.0.1` ports per
[agent-verification.md](../spec/platform/agent-verification.md); they have no hostnames.

### 3. This map is human-owned; agents consume it

Agents map `wrangler.jsonc` routes, CORS/origin allow-lists, and WorkOS redirect URLs **from this
table**. They do not add, rename, or invent a hostname. A new public surface requires a new ADR (or
an amendment here), not an agent's choice.

## Considered options

- **Path-based on the apex** (`splitch.dev/api`, `/mcp`, …). Rejected: couples all surfaces to one
  host, complicates per-Worker WAF/origin rules, and muddies the Client-Key origin allow-list, which
  is origin-scoped per [ADR-0034](0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md).
- **Split product vs edge zones** (a second short domain for the hot path). Rejected for v1: adds a
  second zone to own and certify for no current benefit. Revisit if the data plane needs independent
  DNS/anycast posture.
- **Let agents pick hostnames at slice time.** Rejected: it's a branding/identity/security decision,
  and divergent guesses would scatter across routes, CORS, and auth config.

## Consequences

- WorkOS redirect/callback URLs, the Client-Key origin allow-list, and `wrangler.jsonc` routes all
  derive from a single fixed table — no per-slice guessing.
- The domain-ownership half of the production-domains human blocker is closed (`splitch.dev` is
  owned on Cloudflare). What remains is agent-doable route attachment.
- Adding a public surface is a deliberate, reviewed act (new ADR), not a silent default.

## Sources

- [spec/platform/deployment-pipeline.md](../spec/platform/deployment-pipeline.md) — Cloudflare
  resource contract, per-Worker bindings, platform targets.
- [spec/platform/agent-verification.md](../spec/platform/agent-verification.md) — local Worker
  smoke ports and the internal-vs-public split.
- [0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md](0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)
  — origin-closed Client Keys (why per-host origin scoping matters).
- [../agents/workflow/config.md](../agents/workflow/config.md) — tracker workflow and
  environment-safety contract for external setup tickets.
