# Remote MCP server and CLI as parity skins over a shared typed client; thin 1:1; invariants in the Worker

**Status:** accepted

The control plane is operated through **two interfaces** — a **remote MCP server** (the primary surface for
AI agents) and a **CLI** (for humans at a terminal, and as an agent fallback). They are kept **in parity by
construction**: both are thin, audience-appropriate **skins** over the *same* control-plane API, sharing a
single typed client. The same operations are available through both; a new endpoint becomes a new MCP tool
*and* a new CLI command mechanically, with no per-surface business logic to drift out of sync.

**Parity is at the operations layer, not the presentation layer.** What is shared is the **typed API client**
(generated from the contracts-first OpenAPI/Zod contract, ADR-0017) — every operation is one client method
both skins call. What is **deliberately not shared** is rendering and invocation model: the CLI returns
formatted text + exit codes for humans; the MCP server returns structured, schema-typed tool results for
agents. Forcing one renderer on both would make both worse; "parity" means same *capability*, not same
*output*.

**Three layers:**

```
control-plane HTTP API (Worker)  +  auth.md / auth-issuer (ADR-0022)   <- single source of truth
            ^
   shared typed client (from Zod/OpenAPI contract)                     <- used by BOTH skins
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
the agent **in-band** via the auth.md discovery handshake (a `401 + WWW-Authenticate` kicks off the ID-JAG /
device flow of ADR-0022; subsequent tool calls carry the resulting control-plane token). The MCP server is
therefore the **same origin as the auth-issuer's protected resource**. Consequently the **on-disk credential
store is CLI-only** (keychain, with a mode-0600 `~/.<cli>/credentials.json` fallback for sandboxes); the MCP
server holds its token in the transport session and never touches disk.

## Considered options

- **Local / stdio MCP server** (agent spawns a subprocess that reads an on-disk credential) — rejected. It
  reintroduces an install/distribution/versioning problem for the *agent* path (the very friction MCP was
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
  trivially in parity. Composite task-tools are added *surgically* only where agent ergonomics genuinely need
  a one-shot multi-step operation — never as the means of enforcing correctness (that is always the Worker's
  job).
- **Deep parity (shared outer layer / shared renderer)** — rejected: it fights both audiences. Parity is
  defined at the shared *client*, not the presentation skin.

## Consequences

- **One shared typed client** (from the ADR-0017 contract) is the load-bearing shared artifact; the CLI and
  MCP server are thin wrappers. Adding an endpoint propagates to both surfaces mechanically.
- **The Control Plane API Worker carries management invariant enforcement** — the API must be designed to refuse invalid
  states, returning clear errors both a human and an agent can act on. This is not new work caused by this
  ADR; it is where ADR-0002/0003 invariants must live regardless, now made the *sole* guardian.
- **The remote MCP server composes with ADR-0022** — it is an auth-issuer-gated Worker; connecting *is*
  authenticating. No separate "log in then connect" step for agents.
- **Credential storage is CLI-only** (keychain / 0600 file, holding the ID-JAG `identity_assertion` or the
  device-flow refresh token); the MCP server is stateless on disk.
- **A human CLI is a first-class deliverable**, not an afterthought — it shares the client and credential
  module and is the path for terminal-driven and scripted operation.
