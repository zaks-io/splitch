#!/usr/bin/env node
/**
 * Browser pagehide smoke for `@splitch/sdk/browser`.
 *
 * Phase 1 is the happy path (default fetch, no probe): init, sync read, and
 * pagehide keepalive delivery against a stubbed origin. It does **not** catch
 * unbound Window.fetch / SPL-321 — that coverage is phase 2 (this-checking
 * fetch wrapper; bind removal) and phase 3 (user-supplied `fetch: window.fetch`;
 * member-call receiver). Do not drop phases 2–3 to save Playwright time.
 *
 * Manual: `pnpm -F @splitch/sdk test:browser-pagehide` after build.
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
      exposureIdentity: "pagehide-exposure-identity",
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
      {"imports":{"@splitch/sdk/browser":"/sdk/browser/index.js"}}
    </script>
  </head>
  <body>
    <pre id="out">pending</pre>
    <script type="module">
      import { createSplitchBrowserClient } from "@splitch/sdk/browser";
      const out = document.getElementById("out");
      window.__SPLITCH_PAGEHIDE_SMOKE__ = { phase: "boot" };
      try {
        const useWindowFetch = new URLSearchParams(location.search).get("fetch") === "window";
        const client = createSplitchBrowserClient({
          clientKey: "pk_pagehide_smoke",
          context: { targetingKey: "smoke-user" },
          endpoint: window.location.origin,
          ...(useWindowFetch ? { fetch: window.fetch } : {}),
        });
        await client.init();
        client.evaluate("pagehide-flag", false);
        window.__SPLITCH_PAGEHIDE_SMOKE__ = { phase: "armed", fetchMode: useWindowFetch ? "window" : "default" };
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
  return { chromium: playwright.chromium, cliPath: join(dirname(playwrightEntry), "cli.js") };
}

function startStubServer(state) {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: stub edge router for Playwright smoke
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/sdk/evaluate-all" && req.method === "POST") {
      state.evaluateAll += 1;
      res.writeHead(200, { "content-type": "application/json", etag: '"pagehide-etag"' });
      res.end(EVALUATE_ALL_BODY);
      return;
    }
    if (url.pathname === "/api/sdk/exposures" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        state.exposures.push({ body, authorization: req.headers.authorization ?? null });
        const parsed = JSON.parse(body);
        res.writeHead(202, { "content-type": "application/json" });
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
      const filePath = safeJoin(join(packageRoot, "dist"), url.pathname.slice("/sdk/".length));
      if (filePath === null || !existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
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
    if (existsSync(chromium.executablePath())) {
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

/**
 * Strict-mode fetch probe: rejects an unbound Window.fetch so deleting
 * `.bind(globalThis)` at the client default path is observable in Chromium.
 * Classic scripts are sloppy-mode; without "use strict" an undefined receiver
 * is coerced to window before the check runs.
 */
async function installThisCheckingFetchProbe(page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.__SPLITCH_FETCH_LOG__ = [];
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: must mirror Window.fetch this-checks
    window.fetch = function fetch(input, init) {
      // biome-ignore lint/suspicious/noRedundantUseStrict: Playwright addInitScript is a classic (sloppy) script; without "use strict", an unbound call coerces this to window and the receiver probe cannot detect the SPL-321 bind bug
      "use strict";
      if (this !== window) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = init?.headers && typeof init.headers === "object" ? init.headers : null;
      window.__SPLITCH_FETCH_LOG__.push({
        url,
        keepalive: Boolean(init?.keepalive),
        authorization: headers ? (headers.authorization ?? headers.Authorization ?? null) : null,
      });
      return originalFetch(input, init);
    };
  });
}

async function runArmedPagehide(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__SPLITCH_PAGEHIDE_SMOKE__?.phase === "armed", null, {
    timeout: 15_000,
  });
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
}

async function waitForExposureCount(page, state, prior, label) {
  const deadline = Date.now() + 10_000;
  while (state.exposures.length <= prior && Date.now() < deadline) {
    await page.waitForTimeout(50);
  }
  if (state.exposures.length <= prior) {
    const smoke = await page.evaluate(() => window.__SPLITCH_PAGEHIDE_SMOKE__);
    throw new Error(`${label}: exposures route never hit (${JSON.stringify(smoke)})`);
  }
  const last = state.exposures[state.exposures.length - 1];
  if (typeof last?.authorization !== "string" || !last.authorization.startsWith("Bearer ")) {
    throw new Error(`${label}: missing Authorization (${JSON.stringify(last)})`);
  }
}

async function runUnpatchedPhase(browser, baseUrl, state) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const routed = [];
  await page.route("**/api/sdk/exposures", async (route) => {
    routed.push({ authorization: route.request().headers().authorization ?? null });
    await route.continue();
  });
  const before = state.exposures.length;
  await runArmedPagehide(page, baseUrl);
  await waitForExposureCount(page, state, before, "unpatched pagehide phase");
  if (
    routed.length > 0 &&
    (typeof routed[0]?.authorization !== "string" || !routed[0].authorization.startsWith("Bearer "))
  ) {
    throw new Error(`page.route Authorization missing: ${JSON.stringify(routed)}`);
  }
  await context.close();
}

async function runKeepaliveProbePhase(browser, baseUrl, state) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installThisCheckingFetchProbe(page);
  const before = state.exposures.length;
  await runArmedPagehide(page, baseUrl);
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
    throw new Error(`keepalive phase missing exposures fetch: ${JSON.stringify(fetchLog)}`);
  }
  if (exposureFetch.keepalive !== true) {
    throw new Error(
      `keepalive phase expected keepalive:true, got ${JSON.stringify(exposureFetch)}`,
    );
  }
  if (
    typeof exposureFetch.authorization !== "string" ||
    !exposureFetch.authorization.startsWith("Bearer ")
  ) {
    throw new Error(
      `keepalive phase expected Authorization bearer, got ${JSON.stringify(exposureFetch)}`,
    );
  }
  if (state.exposures.length <= before) {
    throw new Error("keepalive phase: exposures route never received a body");
  }
  await context.close();
}

async function runWindowFetchOptionPhase(browser, baseUrl, state) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const before = state.exposures.length;
  await runArmedPagehide(page, `${baseUrl}?fetch=window`);
  await waitForExposureCount(page, state, before, "window.fetch option phase");
  const smoke = await page.evaluate(() => window.__SPLITCH_PAGEHIDE_SMOKE__);
  if (smoke?.fetchMode !== "window") {
    throw new Error(`window.fetch phase expected fetchMode=window, got ${JSON.stringify(smoke)}`);
  }
  await context.close();
  console.log(
    "browser pagehide smoke passed:",
    JSON.stringify({
      evaluateAll: state.evaluateAll,
      exposures: state.exposures.length,
      windowFetchOption: true,
    }),
  );
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
    // Phase 1: happy path with the default fetch (no receiver probe).
    await runUnpatchedPhase(browser, baseUrl, state);
    // Phase 2: this-checking probe for keepalive + Authorization on the call site.
    await runKeepaliveProbePhase(browser, baseUrl, state);
    // Phase 3: consumer-supplied `fetch: window.fetch` must not Illegal-invocation (B1).
    await runWindowFetchOptionPhase(browser, baseUrl, state);
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
