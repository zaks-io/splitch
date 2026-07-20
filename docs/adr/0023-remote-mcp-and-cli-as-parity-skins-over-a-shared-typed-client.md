# Remote MCP server and CLI as parity skins over the Control Plane SDK; thin 1:1; invariants in the Worker

**Status:** accepted; amended 2026-07-19

## 2026-07-19 amendment: MCP is its own protected resource

The MCP Worker is not the same origin as Auth API or the Control Plane protected resource. Its PRM
advertises the exact challenged MCP resource, and Auth API mints an RS256 access token with that exact
`aud`. MCP verifies the bearer locally through Auth API JWKS and never forwards it. Each tool call is
instead carried over the owning Worker's service-binding entrypoint with a short-lived, one-use
delegated credential. Control Plane, Evaluation, and Analysis each have a separate pairwise secret;
the three credentials are not interchangeable. This amends only the transport trust boundary. The
original parity, remote-only, and Worker-owned-invariant decisions remain accepted.

The control plane is operated through **two interfaces** — a **remote MCP server** (the primary surface for
AI agents) and a **CLI** (for humans at a terminal, and as an agent fallback). They are kept **in parity by
construction**: both are thin, audience-appropriate **skins** over the _same_ control-plane API, sharing a
single Control Plane SDK. The same operations are available through both; a new endpoint becomes a new MCP tool
_and_ a new CLI command mechanically, with no per-surface business logic to drift out of sync.

**Parity is at the operations layer, not the presentation layer.** What is shared is the **Control Plane SDK**
(derived from the contracts-first OpenAPI/Zod contract, ADR-0017) — every operation is one SDK method both
skins call. What is **deliberately not shared** is rendering and invocation model: the CLI returns
formatted text + exit codes for humans; the MCP server returns structured, schema-typed tool results for
agents. Forcing one renderer on both would make both worse; "parity" means same _capability_, not same
_output_.

**Three layers:**

```
control-plane HTTP API (Worker)  +  auth.md / auth-api (ADR-0022)   <- single source of truth
            ^
   Control Plane SDK (from Zod/OpenAPI contract)                       <- used by BOTH skins
            ^
   ┌────────┴────────┐
   CLI (humans)     remote MCP server (agents)                         <- thin skins, different renderers
```

**Thin 1:1 tools/commands; all domain invariants enforced in the Worker.** MCP tools and CLI commands map
one-to-one onto control-plane endpoints. A 1:1 interface is only as safe as the API it mirrors, so the
**Control Plane API Worker is the sole guardian of every management invariant** — it must refuse to represent an invalid
state (e.g. an edit that would mutate a frozen Run's assignment config fails at the Worker with a clear,
agent-actionable error; ADR-0002/0003). Invariant logic lives in **one place** and both surfaces inherit
correctness for free; no invariant lives in a tool or a command.

**Remote MCP only — no stdio.** The MCP server is a **Worker URL**, not a local subprocess. It authenticates
the agent **in-band** via the auth.md discovery handshake (a `401 + WWW-Authenticate` leads through PRM and
authorization-server metadata; subsequent tool calls carry an access token bound to the exact MCP
resource). The MCP Worker verifies that bearer locally and contains it at that boundary. Consequently the
**on-disk credential store is CLI-only** (keychain, with a mode-0600
`~/.<cli>/credentials.json` fallback for sandboxes); the MCP server never touches disk.

## Considered options

- **Local / stdio MCP server** (agent spawns a subprocess that reads an on-disk credential) — rejected. It
  reintroduces an install/distribution/versioning problem for the _agent_ path (the very friction MCP was
  chosen to remove), and forces a second auth model (credential-already-on-disk) alongside the in-band
  handshake. Remote is a URL with zero install and exercises the auth.md flow directly. The human already has
  the CLI for the on-disk-credential case, so stdio adds nothing to the agent story.
- **CLI only** — rejected: a CLI is not the native shape for an agent (it parses stdout, guesses flags), and
  it is an installable artifact in every agent sandbox. MCP gives agents typed tools + built-in discovery and
  is just a URL.
- **MCP only** — rejected: a human cannot drive an MCP server from a shell, and CI/scripting wants a
  `curl`-able / pipeable one-shot. The user explicitly wants terminal access too.
- **Task-shaped (higher-altitude) tools by default** instead of thin 1:1 — rejected as the default. Because
  invariants are enforced in the Worker, a thin 1:1 surface is already safe, and 1:1 keeps the two skins
  trivially in parity. Composite task-tools are added _surgically_ only where agent ergonomics genuinely need
  a one-shot multi-step operation — never as the means of enforcing correctness (that is always the Worker's
  job).
- **Deep parity (shared outer layer / shared renderer)** — rejected: it fights both audiences. Parity is
  defined at the shared _SDK_, not the presentation skin.

## Consequences

- **One shared Control Plane SDK** (from the ADR-0017 contract) is the load-bearing shared artifact; the
  CLI and MCP server are thin wrappers. Adding an endpoint propagates to both surfaces mechanically.
- **The Control Plane API Worker carries management invariant enforcement** — the API must be designed to refuse invalid
  states, returning clear errors both a human and an agent can act on. This is not new work caused by this
  ADR; it is where ADR-0002/0003 invariants must live regardless, now made the _sole_ guardian.
- **The remote MCP server composes with ADR-0022** — it is an auth-api-gated Worker; connecting _is_
  authenticating. No separate "log in then connect" step for agents. Client bearers terminate at MCP;
  downstream calls use separate, resource-narrow delegated credentials over service bindings.
- **Credential storage is CLI-only** (keychain / 0600 file, holding the ID-JAG `identity_assertion` or the
  device-flow refresh token); the MCP server is stateless on disk.
- **A human CLI is a first-class deliverable**, not an afterthought — it shares the SDK and credential
  module and is the path for terminal-driven and scripted operation.
