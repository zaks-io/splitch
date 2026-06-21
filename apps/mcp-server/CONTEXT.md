# MCP Server context

Read this when touching `apps/mcp-server`, agent tools, or MCP prompts.

## Role

The MCP server is an agent-facing control-plane skin over the shared typed client. It does not create
new domain terms. It should make the correct existing terms easy for agents to use.

## Agent wording

- Use Organization, App, and Environment as the scope chain.
- Use Promote for moving Flag Configuration or Variant availability across Environments.
- Use Start and End for Experiment Run lifecycle.
- Use Client Key for public client SDK wiring.
- Use API Key for secret server SDK wiring.
- Say test evaluation or dry-run when no Exposure should be recorded.

## Key handling

- Agents may retrieve and share Client Keys.
- Agents may provision and revoke API Keys.
- Agents must not read or paste an existing API Key value.
- If an API Key is created, surface the value once and direct the developer to store it.

## Avoid

- Do not invent friendlier synonyms for canonical terms.
- Do not use publish.
- Do not imply the agent can access Targeting Rules through a Client Key.
- Do not call dry-run evaluation an Exposure.

## Related context

- Control-plane terms: [`../control-plane-api/CONTEXT.md`](../control-plane-api/CONTEXT.md)
- Evaluation and dry-run: [`../evaluation-api/CONTEXT.md`](../evaluation-api/CONTEXT.md)
- Control Plane SDK: [`../../packages/control-plane-sdk/CONTEXT.md`](../../packages/control-plane-sdk/CONTEXT.md)
