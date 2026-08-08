#!/usr/bin/env node
/**
 * Browser pagehide smoke: load `@splitch/sdk/browser` in real Chromium, enqueue
 * an Exposure on first read, dispatch `pagehide`, and assert the exposures
 * route was hit with `fetch(..., { keepalive: true })`.
 *
 * jsdom cannot prove Window.fetch keepalive + pagehide wiring (SPL-321 lesson).
 * Manual: `pnpm -F @splitch/sdk test:browser-pagehide` after build. Out of
 * `verify:ci` for the same Chromium-download reason as browser-smoke.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distBrowser = join(packageRoot, "dist", "browser", "index.js");
const repoRoot = resolve(packageRoot, "../..");
const requireFromRepo = createRequire(join(repoRoot, "package.json"));

if (!existsSync(distBrowser)) {
  throw new Error(
    `browser-pagehide-smoke requires a built dist at ${distBrowser}; run pnpm build first`,
  );
}

const EVALUATE_ALL_BODY = JSON.stringify({
  evaluations: {
    "pagehide-flag": {
      variant: true,
      variantName: "on",
      reason: "SPLIT",
      errorCode: null,
      exposureTicket: "ticket-pagehide",
    },
  },
});

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>splitch sdk browser pagehide smoke</title>
    <script type="importmap">
      {
        "imports": {
          "@splitch/sdk/browser": "/sdk/browser/index.js"
        }
      }
    </script>
  </head>
  <body>
    <pre id="out">pending</pre>
    <script type="module">
      import { createSplitchBrowserClient } from "@splitch/sdk/browser";

      const out = document.getElementById("out");
      window.__SPLITCH_PAGEHIDE_SMOKE__ = { phase: "boot" };
      try {
        const client = createSplitchBrowserClient({
          clientKey: "pk_pagehide_smoke",
          context: { targetingKey: "smoke-user" },
          endpoint: window.location.origin,
        });
        await client.init();
        client.evaluate("pagehide-flag", false);
        window.__SPLITCH_PAGEHIDE_SMOKE__ = { phase: "armed" };
        out.textContent = "armed";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.__SPLITCH_PAGEHIDE_SMOKE__ = { phase: "error", message };
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

function startStubServer(state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/api/sdk/evaluate-all" && req.method === "POST") {
      state.evaluateAll += 1;
      res.writeHead(200, {
        "content-type": "application/json",
        etag: '"pagehide-etag"',
      });
      res.end(EVALUATE_ALL_BODY);
      return;
    }

    if (url.pathname === "/api/sdk/exposures" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        state.exposures.push({
          body,
          authorization: req.headers.authorization ?? null,
          // Chromium does not expose keepalive on the Node server; the page
          // records it via a fetch monkey-patch below when available. Here we
          // still prove the authenticated POST fired after pagehide.
        });
        res.writeHead(202, { "content-type": "application/json" });
        const parsed = JSON.parse(body);
        res.end(
          JSON.stringify({
            results: (parsed.exposures ?? []).map((item) => ({
              exposureId: item.exposureId,
              status: "accepted",
              code: null,
            })),
          }),
        );
      });
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
    // Not installed yet.
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

  const state = { evaluateAll: 0, exposures: [] };
  const { server, port } = await startStubServer(state);
  const baseUrl = `http://127.0.0.1:${port}/`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Capture keepalive from the page's own fetch calls — the only browser-real
    // way to observe it (Node never sees the Request.keepalive bit).
    await page.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.__SPLITCH_FETCH_LOG__ = [];
      window.fetch = (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        window.__SPLITCH_FETCH_LOG__.push({
          url,
          keepalive: Boolean(init && init.keepalive),
          authorization:
            init && init.headers && typeof init.headers === "object"
              ? (init.headers.authorization ?? init.headers.Authorization ?? null)
              : null,
        });
        return originalFetch(input, init);
      };
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__SPLITCH_PAGEHIDE_SMOKE__?.phase === "armed", null, {
      timeout: 15_000,
    });

    await page.evaluate(() => {
      window.dispatchEvent(new Event("pagehide"));
    });

    await page.waitForFunction(
      () =>
        (window.__SPLITCH_FETCH_LOG__ ?? []).some(
          (row) => typeof row.url === "string" && row.url.includes("/api/sdk/exposures"),
        ),
      null,
      { timeout: 10_000 },
    );

    const fetchLog = await page.evaluate(() => window.__SPLITCH_FETCH_LOG__);
    const exposureFetch = fetchLog.find(
      (row) => typeof row.url === "string" && row.url.includes("/api/sdk/exposures"),
    );
    if (exposureFetch === undefined) {
      throw new Error(`pagehide smoke missing exposures fetch: ${JSON.stringify(fetchLog)}`);
    }
    if (exposureFetch.keepalive !== true) {
      throw new Error(
        `pagehide smoke expected keepalive:true, got ${JSON.stringify(exposureFetch)}`,
      );
    }
    if (
      typeof exposureFetch.authorization !== "string" ||
      !exposureFetch.authorization.startsWith("Bearer ")
    ) {
      throw new Error(
        `pagehide smoke expected Authorization bearer, got ${JSON.stringify(exposureFetch)}`,
      );
    }
    if (state.exposures.length < 1) {
      throw new Error("pagehide smoke: exposures route never received a body");
    }

    console.log(
      "browser pagehide smoke passed:",
      JSON.stringify({
        evaluateAll: state.evaluateAll,
        exposures: state.exposures.length,
        keepalive: exposureFetch.keepalive,
      }),
    );
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
