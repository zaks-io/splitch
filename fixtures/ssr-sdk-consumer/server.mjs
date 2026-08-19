import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSplitchClient } from "@splitch/sdk";

export const FLAG_KEY = "new-checkout";
export const EVALUATION_CONTEXT = Object.freeze({
  targetingKey: "ssr-user-123",
  idType: "user",
  attributes: Object.freeze({ plan: "pro" }),
});

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const sdkDistRoot = resolve(fixtureRoot, "node_modules/@splitch/sdk/dist");

export function serializeJsonForHtml(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("SSR JSON value is not serializable");
  }
  return serialized
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtmlText(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function renderPage({ bootstrap, browserContext, clientKey, endpoint }) {
  const entry = bootstrap.evaluations[FLAG_KEY];
  if (entry === undefined || typeof entry.variant !== "boolean" || entry.reason === "ERROR") {
    throw new Error(`SSR requires a successful ${FLAG_KEY} evaluation`);
  }
  const serverValueJson = JSON.stringify(entry.variant);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>splitch SSR fixture</title>
    <script type="importmap">{"imports":{"@splitch/sdk/browser":"/vendor/sdk/browser/index.js"}}</script>
  </head>
  <body>
    <main>
      <h1>Server-rendered Flag</h1>
      <pre id="flag-value">${escapeHtmlText(serverValueJson)}</pre>
    </main>
    <script id="splitch-bootstrap" type="application/json">${serializeJsonForHtml(bootstrap)}</script>
    <script id="splitch-config" type="application/json">${serializeJsonForHtml({
      clientKey,
      context: browserContext,
      endpoint,
      flagKey: FLAG_KEY,
    })}</script>
    <script type="module" src="/browser.mjs"></script>
  </body>
</html>`;
}

function contentType(pathname) {
  return extname(pathname) === ".js" || extname(pathname) === ".mjs"
    ? "text/javascript; charset=utf-8"
    : "application/octet-stream";
}

async function serveFile(response, pathname, root, prefix) {
  const target = resolve(root, pathname.slice(prefix.length));
  if (!target.startsWith(`${root}${sep}`)) {
    response.writeHead(404).end("Not Found");
    return;
  }
  try {
    const contents = await readFile(target);
    response.writeHead(200, { "content-type": contentType(target) });
    response.end(contents);
  } catch {
    response.writeHead(404).end("Not Found");
  }
}

export function createSsrServer(options) {
  const apiKey = requiredString(options.apiKey, "apiKey");
  const clientKey = requiredString(options.clientKey, "clientKey");
  const endpoint = requiredString(options.endpoint, "endpoint");
  const splitch = createSplitchClient({ apiKey, endpoint });

  return createServer((request, response) => {
    void handleRequest(request, response, splitch, clientKey, endpoint).catch((error) => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "SSR failed");
    });
  });
}

async function handleRequest(request, response, splitch, clientKey, endpoint) {
  const url = new URL(request.url ?? "/", "http://fixture.local");
  if (url.pathname === "/browser.mjs") {
    await serveFile(response, url.pathname, fixtureRoot, "/");
    return;
  }
  if (url.pathname.startsWith("/vendor/sdk/")) {
    await serveFile(response, url.pathname, sdkDistRoot, "/vendor/sdk/");
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404).end("Not Found");
    return;
  }

  const bootstrap = await splitch.evaluateAll(EVALUATION_CONTEXT);
  const browserContext =
    url.searchParams.get("mismatch") === "1"
      ? { ...EVALUATION_CONTEXT, targetingKey: "different-user" }
      : EVALUATION_CONTEXT;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(renderPage({ bootstrap, browserContext, clientKey, endpoint }));
}
