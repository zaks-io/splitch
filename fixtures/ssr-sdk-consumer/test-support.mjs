import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const consumerRoot = process.env.SPLITCH_SSR_CONSUMER_ROOT;
if (!consumerRoot) throw new Error("SPLITCH_SSR_CONSUMER_ROOT is required");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("server did not expose an address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createEdgeDouble() {
  const calls = [];
  const corsHeaders = {
    "access-control-allow-headers":
      "authorization, content-type, idempotency-key, if-none-match, x-splitch-sdk-runtime",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-origin": "*",
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://edge.test");
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders).end();
        return;
      }
      const body = await readJson(request);
      calls.push({
        authorization: request.headers.authorization,
        body,
        idempotencyKey: request.headers["idempotency-key"],
        path: url.pathname,
      });

      if (url.pathname === "/api/sdk/evaluate-all") {
        response.writeHead(200, {
          ...corsHeaders,
          "content-type": "application/json",
          etag: '"ssr-fixture-1"',
        });
        response.end(
          JSON.stringify({
            evaluations: {
              "new-checkout": {
                variant: true,
                variantName: "treatment",
                reason: "SPLIT",
                errorCode: null,
                exposureTicket: "ticket-ssr-fixture-1",
                exposureIdentity: "binding-ssr-fixture-1",
              },
            },
          }),
        );
        return;
      }
      if (url.pathname === "/api/sdk/exposures") {
        response.writeHead(202, { ...corsHeaders, "content-type": "application/json" });
        response.end(
          JSON.stringify({
            results: body.exposures.map(({ exposureId }) => ({
              exposureId,
              status: "accepted",
              code: null,
            })),
          }),
        );
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "unexpected route" }));
    })().catch((error) => {
      response.writeHead(500).end(error instanceof Error ? error.message : "edge double failed");
    });
  });
  return { calls, server };
}

export async function withFixture(run) {
  const edge = createEdgeDouble();
  let ssrServer;
  try {
    const edgeOrigin = await listen(edge.server);
    const serverModule = await import(pathToFileURL(join(consumerRoot, "server.mjs")));
    ssrServer = serverModule.createSsrServer({
      apiKey: "sk_ssr_fixture",
      clientKey: "pk_ssr_fixture",
      endpoint: edgeOrigin,
    });
    const ssrOrigin = await listen(ssrServer);
    await run({ edge, edgeOrigin, ssrOrigin });
  } finally {
    await Promise.all([
      ssrServer?.listening ? close(ssrServer) : undefined,
      edge.server.listening ? close(edge.server) : undefined,
    ]);
  }
}
