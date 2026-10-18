import { check } from "./cli-pat-local-fixture.mjs";

export async function assertTemporaryKey(
  { fleet, flag, workSignal, sequence },
  key,
  expected,
  expiresAt,
) {
  const status =
    typeof expected === "boolean" ? 200 : expected === "ENVIRONMENT_EXPIRED" ? 410 : 403;
  check(typeof key === "string", "Environment omitted credential material");
  const isClient = key.startsWith("pk_");
  const response = await fetch(
    `${fleet.serviceOrigin("evaluation-api")}/api/sdk/${isClient ? "evaluate" : "verify"}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": `temporary-e2e-${sequence}`,
      },
      body: JSON.stringify({
        flagKey: flag,
        targetingKey: "local-temporary-e2e",
        idType: "user",
        attributes: {},
      }),
      signal: AbortSignal.any([workSignal, AbortSignal.timeout(30_000)]),
    },
  );
  const body = await response.json();
  check(
    response.status === status,
    `Data-plane ${isClient ? "Client" : "API"} Key HTTP ${response.status}; expected ${status}`,
  );
  const value = isClient ? body.variant : body.value;
  check(
    (typeof expected === "boolean" ? value : body.code) === expected,
    "Data-plane result did not match lifecycle state",
  );
  if (expiresAt)
    check(body.details?.expiredAt === expiresAt, "Expiry response lost its original ISO datetime");
}

export async function callTemporaryMcp(
  { fleet, secret, workSignal, appId, state },
  name,
  args,
  expectedCode,
) {
  async function rpc(method, params) {
    const response = await fetch(`${fleet.serviceOrigin("mcp-server")}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(state.sessionId ? { "mcp-session-id": state.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++state.sequence, method, params }),
      signal: AbortSignal.any([workSignal, AbortSignal.timeout(45_000)]),
    });
    check(response.ok, `MCP HTTP request failed with ${response.status}`);
    return response;
  }
  if (!state.sessionId) {
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "temporary-environments-e2e", version: "1.0.0" },
    });
    state.sessionId = initialized.headers.get("mcp-session-id");
    check(
      state.sessionId && (await initialized.json()).result?.protocolVersion,
      "MCP initialization omitted session/protocol",
    );
  }
  const body = await (await rpc("tools/call", { name, arguments: { appId, ...args } })).json();
  check(
    body.result && !body.error && (expectedCode ? body.result.isError : !body.result.isError),
    `MCP ${name} failed; private response suppressed`,
  );
  check(body.result.structuredContent, "MCP tool omitted structuredContent");
  if (expectedCode)
    check(body.result.structuredContent.code === expectedCode, `MCP ${name} lost its refusal code`);
  return body.result.structuredContent;
}

export async function publishTemporarySources(cli, flag) {
  await cli([
    "flags",
    "create",
    "--key",
    flag,
    "--lifecycle-class",
    "permission",
    "--variants",
    "on,off",
  ]);
  await cli([
    "flag-config",
    "update",
    flag,
    "--env",
    "dev",
    "--enabled",
    "true",
    "--body-json",
    JSON.stringify({ rollout: { percentage: 100 } }),
  ]);
  await cli([
    "flag-config",
    "update",
    flag,
    "--env",
    "prod",
    "--enabled",
    "true",
    "--confirm",
    "--body-json",
    JSON.stringify({ rollout: { percentage: 100 } }),
  ]);
}
