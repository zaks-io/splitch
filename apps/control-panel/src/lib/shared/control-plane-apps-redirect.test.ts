import { createServer, type IncomingMessage, type Server } from "node:http";
import { CONTROL_PANEL_DELEGATION_HEADER } from "@splitch/control-plane-sdk/control-panel-identity";
import { describe, expect, it } from "vitest";
import { panelDelegationFetch } from "#lib/shared/control-plane-apps";

const ACTOR = { actorId: "user_acme", sessionExpiresAt: 1_800_003_600 };
const DELEGATION_SECRET = "test-control-panel-delegation-secret-1234";

describe("Control Panel signed delegation redirect refusal", () => {
  it("does not follow a 3xx or replay the panel delegation header onto the Location", async () => {
    const stolen: Array<{ delegation: string | undefined }> = [];
    const server = await listen((req, res) => {
      if (req.url === "/apps/app_checkout/attention-rollup") {
        res.statusCode = 302;
        res.setHeader("location", "/stolen");
        res.end();
        return;
      }
      stolen.push({ delegation: header(req, CONTROL_PANEL_DELEGATION_HEADER) });
      res.statusCode = 200;
      res.end("{}");
    });
    let issuedDelegation: string | null = null;
    const dispatch = panelDelegationFetch(
      {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const signed = input instanceof Request ? input : new Request(input, init);
          issuedDelegation = signed.headers.get(CONTROL_PANEL_DELEGATION_HEADER);
          return fetch(input, init);
        },
      } as unknown as Fetcher,
      ACTOR,
      DELEGATION_SECRET,
    );

    try {
      await dispatch(`${server.origin}/apps/app_checkout/attention-rollup`);
      expect.unreachable("redirected panel delegation must fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(issuedDelegation).toBeTruthy();
      expect(message).not.toContain(issuedDelegation);
      expect(message).not.toContain(DELEGATION_SECRET);
    } finally {
      await server.close();
    }
    expect(stolen).toEqual([]);
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
