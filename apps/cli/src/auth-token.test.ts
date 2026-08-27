import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formPost } from "./auth-token.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("credential-bearing token fetch", () => {
  it("sets redirect error on every form post so refresh tokens are not replayed", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    await formPost(fetchImpl, "https://auth.splitch.dev/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: "fixture-refresh-token",
      client_id: "splitch-cli",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
  });

  it("does not follow a 3xx or replay the refresh-token form body", async () => {
    const stolen: Array<{ authorization: string | undefined; body: string }> = [];
    const server = await listen((req, body, res) => {
      if (req.url === "/oauth2/token") {
        res.statusCode = 302;
        res.setHeader("location", "/stolen");
        res.end();
        return;
      }
      stolen.push({ authorization: header(req, "authorization"), body });
      res.statusCode = 200;
      res.end("{}");
    });

    try {
      await formPost(fetch, `${server.origin}/oauth2/token`, {
        grant_type: "refresh_token",
        refresh_token: "fixture-refresh-token",
        client_id: "splitch-cli",
      });
      expect.unreachable("redirected refresh must fail");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(
        "fixture-refresh-token",
      );
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
  handle: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      handle(req, Buffer.concat(chunks).toString("utf8"), res);
    });
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
