#!/usr/bin/env node
/**
 * Browser smoke: load the built SDK `dist` in real Chromium with the default
 * global `fetch` (no override) and assert a non-ERROR resolution against a stub
 * edge. Node/undici cannot catch the Window.fetch "Illegal invocation" bug.
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(packageRoot, "dist", "index.js");
const repoRoot = resolve(packageRoot, "../..");
const requireFromPackage = createRequire(join(packageRoot, "package.json"));
const requireFromRepo = createRequire(join(repoRoot, "package.json"));

if (!existsSync(distEntry)) {
  throw new Error(`browser-smoke requires a built dist at ${distEntry}; run pnpm build first`);
}

const VERIFY_BODY = JSON.stringify({
  value: true,
  variantName: "on",
  reason: "SPLIT",
});

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>splitch sdk browser smoke</title>
    <script type="importmap">
      {
        "imports": {
          "zod": "/vendor/zod/index.js",
          "@splitch/sdk": "/sdk/index.js"
        }
      }
    </script>
  </head>
  <body>
    <pre id="out">pending</pre>
    <script type="module">
      import { createSplitchClient } from "@splitch/sdk";

      const out = document.getElementById("out");
      try {
        // No fetch override — this is the broken path in browsers when the
        // unbound Window.fetch is stored on a config object and called as a method.
        const client = createSplitchClient({
          clientKey: "ck_browser_smoke",
          endpoint: window.location.origin,
        });
        const details = await client.verify("browser-smoke-flag", {
          targetingKey: "smoke-user",
          defaultValue: false,
        });
        window.__SPLITCH_BROWSER_SMOKE__ = details;
        out.textContent = JSON.stringify(details);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.__SPLITCH_BROWSER_SMOKE__ = { reason: "ERROR", errorMessage: message };
        out.textContent = message;
      }
    </script>
  </body>
</html>
`;

function contentType(pathname) {
  if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) {
    return "text/javascript; charset=utf-8";
  }
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (pathname.endsWith(".json") || pathname.endsWith(".map")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

function safeJoin(root, requestPath) {
  const resolved = resolve(root, requestPath);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    return null;
  }
  return resolved;
}

function resolvePlaywright() {
  const playwrightTestEntry = requireFromRepo.resolve("@playwright/test");
  const fromPlaywrightTest = createRequire(playwrightTestEntry);
  const playwrightEntry = fromPlaywrightTest.resolve("playwright");
  const playwright = fromPlaywrightTest("playwright");
  return {
    chromium: playwright.chromium,
    cliPath: join(dirname(playwrightEntry), "cli.js"),
  };
}

function startStubServer() {
  const zodRoot = dirname(requireFromPackage.resolve("zod/package.json"));

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/sdk/verify" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(VERIFY_BODY);
      return;
    }

    if (url.pathname === "/api/sdk/evaluate" && req.method === "POST") {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-run-id": "browser-smoke-run",
        "x-variant-name": "on",
      });
      res.end(JSON.stringify({ variant: true }));
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }

    if (url.pathname.startsWith("/sdk/")) {
      const relative = url.pathname.slice("/sdk/".length);
      const filePath = safeJoin(join(packageRoot, "dist"), relative);
      if (filePath === null || !existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(readFileSync(filePath));
      return;
    }

    if (url.pathname.startsWith("/vendor/zod/")) {
      const relative = url.pathname.slice("/vendor/zod/".length);
      const filePath = safeJoin(zodRoot, relative);
      if (filePath === null || !existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404).end("not found");
  });

  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("expected a TCP listen address");
      }
      resolveListen({ server, port: address.port });
    });
  });
}

function ensureChromium(cliPath, chromium) {
  try {
    const executablePath = chromium.executablePath();
    if (existsSync(executablePath)) {
      return;
    }
  } catch {
    // Not installed yet — fall through to install.
  }
  execFileSync(process.execPath, [cliPath, "install", "chromium"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

async function main() {
  const { chromium, cliPath } = resolvePlaywright();
  ensureChromium(cliPath, chromium);

  const { server, port } = await startStubServer();
  const baseUrl = `http://127.0.0.1:${port}/`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error instanceof Error ? error.message : String(error));
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__SPLITCH_BROWSER_SMOKE__ !== undefined, null, {
      timeout: 15_000,
    });

    const details = await page.evaluate(() => window.__SPLITCH_BROWSER_SMOKE__);
    if (details == null || typeof details !== "object") {
      throw new Error(`browser-smoke missing result: ${JSON.stringify(details)}`);
    }
    if (details.reason === "ERROR") {
      throw new Error(
        `browser-smoke expected a non-ERROR resolution with default fetch; got ${JSON.stringify(
          details,
        )}${pageErrors.length > 0 ? `; pageerrors=${JSON.stringify(pageErrors)}` : ""}`,
      );
    }
    if (details.value !== true || details.reason !== "SPLIT") {
      throw new Error(`browser-smoke unexpected details: ${JSON.stringify(details)}`);
    }

    console.log("browser smoke passed:", JSON.stringify(details));
  } finally {
    if (browser !== undefined) {
      await browser.close();
    }
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
