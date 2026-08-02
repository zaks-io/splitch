# A route's public address follows its credential, not its owner

**Status:** accepted

`route.owner` in the shared route contract was doing two jobs: naming the Worker that executes a
route, and telling clients which origin to send it to. The two coincided for most routes, so
nothing caught the cases where they diverge. Four routes take a control-plane token but are
implemented elsewhere — Experiment results and Organization usage on the Analysis Worker, Flag
test-eval on the Evaluation Worker — and the CLI dutifully addressed them at their implementation
owner. Analysis has no public hostname ([ADR-0038](0038-public-hostnames-are-a-fixed-human-owned-subdomain-map.md)),
so those commands failed on production telling the operator to set an origin that did not exist,
and test-eval sent an operator's session token to the data-plane edge.

## Decision

A route's public address is a property of the **credential the caller holds**, not of the Worker
that executes it. `publicSurfaceFor(route)` maps auth kind to surface, total over `AuthKind` so a
new kind fails typecheck rather than silently landing at the control plane:

| Auth kind                                 | Public surface                          |
| ----------------------------------------- | --------------------------------------- |
| `control-plane-token`, `public`           | `control-plane-api` (`api.splitch.dev`) |
| `client-key`, `api-key`, `data-plane-key` | `evaluation-api` (`edge.splitch.dev`)   |
| `internal-worker`                         | none — binding-only                     |

`route.owner` is preserved with a single, narrower meaning: the internal execution and delegation
target. It never reaches a client.

Where surface ≠ owner, the surface Worker authorizes the caller through its normal guard chain and
forwards over a service binding to a `ControlPlaneEntrypoint` on the owner. Both sides derive the
route set from the registry (`routesDelegatedBy` / `routesDelegatedTo`), so the gateway and the
allowlist cannot disagree about what delegation covers. The forwarded identity travels as a header
rather than a credential: a `WorkerEntrypoint` is reachable only over a binding, so the receiver
cross-checks the path's Org/App/Environment against the identity as defense against a bug in the
surface Worker, not against a forged header.

One address per operation is enforced per door, not per Worker. A Worker's public `fetch` mounts
only `routesSurfacedBy` itself; the routes it merely executes are mounted on the binding entrypoints
alone. Otherwise the owner's own hostname would keep answering a delegated route directly, and the
operation would have two live addresses: the one clients are told about, which goes through the
surface Worker's authorization, and one that does not. Analysis surfaces nothing, so its public door
mounts no registry route at all — enforced in code rather than by the absence of a DNS record.

Contract tests compare, per Worker and per door, the routes the registry says it mounts against the
routes the Hono app actually mounted, in both directions. That guard is what makes the address model
and the mount model provably the same model.

## Considered options

- **Give Analysis a public hostname.** Rejected. It unblocks the CLI by cementing the wrong
  boundary: every client would then have to know which Worker implements which operation, and each
  new hostname is a new CORS posture, WAF ruleset, and credential-acceptance surface to get right.
  Implementation placement would become a client-visible contract, unmovable without a breaking
  change.
- **Move the four routes to the Workers that own their hostnames.** Rejected. The placement is
  correct: results and usage belong next to the analysis pipes, and test-eval belongs next to the
  evaluation engine it must match exactly. Making clients know about that placement is the bug.
- **Collapse `edge.splitch.dev` into `api.splitch.dev` and route by path.** Rejected, and it is the
  one merge worth naming: the data plane takes a different credential from a different caller (a
  public Client Key from a browser, versus an operator session), it is pinned in customers' shipped
  bundles for years, it carries a `*` CORS policy and open-by-default Client Keys
  ([ADR-0034](0034-edge-abuse-controls-are-a-cloudflare-enforced-product-contract.md)) that the
  control-plane hostname must never inherit, and
  it is a hot path that must survive control-plane deploys. Analysis had none of those properties,
  which is exactly why it merges and edge does not.

## Consequences

`ANALYSIS_API_ORIGIN` is gone from the CLI: there is no client-visible Analysis origin to
configure. The CLI keeps `CONTROL_PLANE_API_ORIGIN`, `AUTH_API_ORIGIN`, and
`EVALUATION_API_ORIGIN` — one per public surface, plus auth.

The MCP Worker is the one client that still routes by owner, because it holds a service binding to
every Worker and no credential-bound origin. That is the same registry entry read from the other
end, not a second routing model.

Delegated routes cost one extra hop and inherit the surface Worker's rate limiting and
idempotency. A missing binding fails loud with `SERVICE_UNAVAILABLE` naming the owner, rather than
degrading to a direct call.

Adding a route whose auth kind implies a surface its owner does not serve now requires a delegation
binding; the mounting contract test fails until one exists.
