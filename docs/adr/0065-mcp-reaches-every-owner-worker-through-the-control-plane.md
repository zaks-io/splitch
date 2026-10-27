# MCP reaches every owner Worker through the Control Plane

**Status:** accepted; supersedes the per-owner transport in the 2026-07-19 amendment to
[ADR-0023](./0023-remote-mcp-and-cli-as-parity-skins-over-a-shared-typed-client.md)

The 2026-07-19 amendment to ADR-0023 had the MCP Worker call each owner Worker (Control Plane,
Evaluation, Analysis) over its own service binding, with a separate pairwise secret per owner. That
let Evaluation and Analysis tools skip the Control Plane's guard chain, including the check that the
Environment in the path belongs to the App in the path. Only the Control Plane can make that check,
because it needs the tenant tables (SPL-313).

The MCP Worker now binds only the Control Plane (`CONTROL_PLANE_API`, entrypoint `McpEntrypoint`).
Each tool call crosses that binding with a short-lived, one-use delegated credential signed with one
secret (`MCP_CONTROL_PLANE_DELEGATION_SECRET`), and the Control Plane claims it once in a strongly
consistent replay object (`MCP_DELEGATION_REPLAY`). A route another Worker owns is a delegated route
([ADR-0046](./0046-a-routes-public-address-follows-its-credential-not-its-owner.md)): the Control
Plane runs the full guard chain, then forwards over its own binding to the owner's
`ControlPlaneEntrypoint`. This is the same door the CLI uses at `api.splitch.dev`.

The rest of the amendment stands. MCP is its own protected resource with its own PRM and exact `aud`,
verifies the bearer locally through Auth API JWKS, and never forwards it. ADR-0023's parity,
remote-only, and Worker-owned-invariant decisions are unchanged.

## Considered options

- **Direct MCP-to-owner bindings with pairwise secrets** (the amendment) — rejected. Each owner Worker
  would have to repeat the tenant checks or trust a caller that skipped them, and MCP would see a
  different guard chain than the CLI for the same operation.
- **The Control Plane as the only door** — accepted. One guard chain for every tool and command. The
  cost is one extra in-datacenter service-binding hop for Evaluation and Analysis tools.

## Consequences

- MCP has one binding and one delegation secret to rotate. Evaluation and Analysis accept no MCP
  credential. They still bind and export the old `McpDelegationReplayDurableObject` class, though
  nothing reads it; removing it takes a Durable Object delete migration.
- A new delegated route reaches MCP and the CLI with no transport change: mounting is derived from
  the route registry.
