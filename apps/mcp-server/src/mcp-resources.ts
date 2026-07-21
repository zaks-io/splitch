import type { McpAccessTokenActor } from "./mcp-access-token";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcResponse,
  jsonRpcError,
  jsonRpcResult,
} from "./json-rpc";
import { buildCapabilitiesResource } from "./mcp-capabilities";
import { CONTEXT_MD, QUICKSTART_MD } from "./mcp-resource-files.generated";
import type { McpSessionContext, McpSessionStore } from "./mcp-session-context";

export const MCP_RESOURCE_URIS = [
  "splitch://context",
  "splitch://auth",
  "splitch://active-context",
  "splitch://capabilities",
  "splitch://quickstart",
] as const;

type McpResourceUri = (typeof MCP_RESOURCE_URIS)[number];

export interface McpResourceDefinition {
  readonly uri: McpResourceUri;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

interface McpResourceContent {
  readonly uri: McpResourceUri;
  readonly mimeType: string;
  readonly text: string;
}

interface McpActiveContextResource {
  readonly app: { readonly id: string } | null;
  readonly environment: { readonly id: string } | null;
  readonly source: "session" | null;
  readonly demoExpiresAt?: string;
}

interface ReadMcpResourceContext {
  readonly actor: McpAccessTokenActor;
  readonly sessionId: string | null;
  readonly sessionStore: McpSessionStore;
  readonly authBaseUrl: string;
  readonly fetchAuthMarkdown?: (authBaseUrl: string) => Promise<string>;
}

interface ReadMcpResourceOptions extends ReadMcpResourceContext {
  readonly uri: string;
}

const RESOURCE_DEFINITIONS: readonly McpResourceDefinition[] = [
  {
    uri: "splitch://context",
    name: "context",
    description: "splitch ubiquitous-language glossary (CONTEXT.md).",
    mimeType: "text/markdown",
  },
  {
    uri: "splitch://auth",
    name: "auth",
    description: "Auth doors and scope widening (auth.md).",
    mimeType: "text/markdown",
  },
  {
    uri: "splitch://active-context",
    name: "active-context",
    description: "Resolved active App and Environment for this MCP session.",
    mimeType: "application/json",
  },
  {
    uri: "splitch://capabilities",
    name: "capabilities",
    description: "Token scopes and the MCP tools they gate.",
    mimeType: "application/json",
  },
  {
    uri: "splitch://quickstart",
    name: "quickstart",
    description: "Agent-first onboarding quickstart (docs/spec/quickstart.md).",
    mimeType: "text/markdown",
  },
];

export function listMcpResources(): { resources: readonly McpResourceDefinition[] } {
  return { resources: RESOURCE_DEFINITIONS };
}

export async function readMcpResourceRpc(
  id: JsonRpcId,
  params: unknown,
  context: ReadMcpResourceContext,
): Promise<JsonRpcResponse> {
  const uri = resourceUri(params);
  if (!uri) {
    return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
  }
  try {
    const content = await readMcpResource({ ...context, uri });
    if (!content) {
      return jsonRpcError(id, JSON_RPC_METHOD_NOT_FOUND, "Method not found");
    }
    return jsonRpcResult(id, { contents: [content] });
  } catch (error) {
    return jsonRpcError(id, JSON_RPC_INTERNAL_ERROR, "Internal error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readMcpResource(
  options: ReadMcpResourceOptions,
): Promise<McpResourceContent | null> {
  if (!isMcpResourceUri(options.uri)) return null;
  switch (options.uri) {
    case "splitch://context":
      return fileResource("splitch://context", "text/markdown", CONTEXT_MD);
    case "splitch://quickstart":
      return fileResource("splitch://quickstart", "text/markdown", QUICKSTART_MD);
    case "splitch://auth":
      return fileResource(
        "splitch://auth",
        "text/markdown",
        await (options.fetchAuthMarkdown ?? defaultFetchAuthMarkdown)(options.authBaseUrl),
      );
    case "splitch://active-context":
      return jsonResource(
        "splitch://active-context",
        await buildActiveContext(options.sessionId, options.sessionStore),
      );
    case "splitch://capabilities":
      return jsonResource("splitch://capabilities", buildCapabilitiesResource(options.actor));
    default:
      return null;
  }
}

function resourceUri(params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const uri = (params as { uri?: unknown }).uri;
  return typeof uri === "string" && uri.length > 0 ? uri : null;
}

function isMcpResourceUri(uri: string): uri is McpResourceUri {
  return (MCP_RESOURCE_URIS as readonly string[]).includes(uri);
}

function fileResource(uri: McpResourceUri, mimeType: string, text: string): McpResourceContent {
  return { uri, mimeType, text };
}

function jsonResource(uri: McpResourceUri, value: unknown): McpResourceContent {
  return { uri, mimeType: "application/json", text: JSON.stringify(value) };
}

async function buildActiveContext(
  sessionId: string | null,
  sessionStore: McpSessionStore,
): Promise<McpActiveContextResource> {
  const context = sessionId ? await readSessionContext(sessionId, sessionStore) : undefined;
  const transport = sessionId ? await readSessionTransport(sessionId, sessionStore) : undefined;
  const payload: McpActiveContextResource = {
    app: context ? { id: context.appId } : null,
    environment: context ? { id: context.environmentId } : null,
    source: context ? "session" : null,
  };
  if (transport?.demoExpiresAt) {
    return { ...payload, demoExpiresAt: transport.demoExpiresAt };
  }
  return payload;
}

async function readSessionContext(
  sessionId: string,
  sessionStore: McpSessionStore,
): Promise<McpSessionContext | undefined> {
  try {
    return await sessionStore.get(sessionId);
  } catch (error) {
    throw resourceReadError(error);
  }
}

async function readSessionTransport(
  sessionId: string,
  sessionStore: McpSessionStore,
): Promise<{ demoExpiresAt?: string } | undefined> {
  try {
    return await sessionStore.getTransport(sessionId);
  } catch (error) {
    throw resourceReadError(error);
  }
}

function resourceReadError(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}

async function defaultFetchAuthMarkdown(authBaseUrl: string): Promise<string> {
  const response = await fetch(new URL("/auth.md", authBaseUrl));
  if (!response.ok) {
    throw new Error(`mcp-server: auth.md fetch failed (${response.status})`);
  }
  return await response.text();
}
