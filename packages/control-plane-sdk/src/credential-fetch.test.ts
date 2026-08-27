import { createServer, type IncomingMessage, type Server } from "node:http";
import { MCP_DELEGATION_HEADER } from "@splitch/contracts";
import { describe, expect, it, vi } from "vitest";
import { requestCarriesCredentials, withoutCredentialRedirect } from "./credential-fetch";
import { createControlPlaneSdk } from "./index";
import { createMcpOperationAdapter } from "./mcp-operation-adapter";

const flagPage = {
  readTruncated: false,
  readLimit: 200,
  cursor: null,
  items: [
    {
      id: "flag_checkout",
      appId: "app_local",
      key: "checkout",
      name: "Checkout",
      variants: [{ id: "var_on", name: "on", value: true }],
      defaultVariantId: "var_on",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    },
  ],
};

describe("credential-bearing control-plane fetch", () => {
  it("treats Authorization and MCP delegation headers as credentials", () => {
    expect(
      requestCarriesCredentials("https://control-plane.test/flags", {
        headers: { authorization: "Bearer secret-token" },
      }),
    ).toBe(true);
    expect(
      requestCarriesCredentials(
        new Request("https://control-plane.test/flags", {
          headers: { [MCP_DELEGATION_HEADER]: "delegation-token" },
        }),
      ),
    ).toBe(true);
    expect(requestCarriesCredentials("https://control-plane.test/health")).toBe(false);
    expect(
      requestCarriesCredentials("https://control-plane.test/flags", {
        headers: { authorization: "" },
      }),
    ).toBe(false);
  });

  it("sets redirect error on authenticated typed SDK requests", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(flagPage),
    );
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await sdk.flags.list({ appId: "app_local" }, { authorization: "Bearer secret-token" });

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      "Bearer secret-token",
    );
  });

  it("does not force redirect error on unauthenticated health()", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true, platformTarget: "local", service: "control-plane-api" }),
    );
    const sdk = createControlPlaneSdk({
      baseUrl: "https://control-plane.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await sdk.health();

    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).not.toBe("error");
  });

  it("sets redirect error on authenticated MCP adapter requests", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(
        input instanceof Request
          ? input.headers.get("authorization")
          : new Headers(init?.headers).get("authorization"),
      ).toBe("Bearer secret-token");
      return Response.json(flagPage);
    });
    const adapter = createMcpOperationAdapter({
      baseUrl: "https://control-plane.test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await adapter.callOperationById(
      "flags_list",
      { appId: "app_local" },
      { authorization: "Bearer secret-token" },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not follow a 3xx or replay Authorization onto the Location", async () => {
    const stolen: Array<{ authorization: string | undefined }> = [];
    const server = await listen((req, res) => {
      if (req.url === "/apps/app_local/flags") {
        res.statusCode = 302;
        res.setHeader("location", "/stolen");
        res.end();
        return;
      }
      stolen.push({ authorization: header(req, "authorization") });
      res.statusCode = 200;
      res.end("{}");
    });
    const sdk = createControlPlaneSdk({
      baseUrl: server.origin,
      fetch: withoutCredentialRedirect(fetch),
    });

    try {
      await sdk.flags.list({ appId: "app_local" }, { authorization: "Bearer secret-token" });
      expect.unreachable("redirected Authorization must fail");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("secret-token");
    }
    expect(stolen).toEqual([]);
    await server.close();
  });
});

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function listen(
  handle: (req: IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
