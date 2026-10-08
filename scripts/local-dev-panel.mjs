#!/usr/bin/env node
/**
 * A throwaway, signed-in Control Panel for agents and humans to look at.
 *
 * Boots the seeded local fleet (D1 + KV fixtures, fake WorkOS credentials) with
 * the Control Panel and all six API Workers in one local Cloudflare runtime, and
 * puts a dev-login gateway in front of the panel:
 *
 *   /__dev/login            pick a fixture persona
 *   /__dev/login/<persona>  mint a fresh session for it, set `__session`, redirect
 *
 * The panel itself is untouched and still has no bypass: the gateway signs in
 * the same way the E2E specs do, by writing a session into the panel's local
 * SESSION_STORE and handing the browser the matching cookie. It also rewrites
 * the panel's `/auth/login` and WorkOS-logout redirects to the dev login page,
 * and maps its own public Origin onto the panel's so same-origin checks
 * (`panel-csrf.ts`, live-update upgrades) still pass behind the proxy.
 *
 * Usage:
 *   pnpm dev:panel                 # http://127.0.0.1:18800
 *   pnpm dev:panel --share         # also publish over HTTPS on the tailnet
 *   pnpm dev:panel --port 18900
 *
 * State lives in test-results/control-panel-e2e-state and is wiped on every
 * start. It shares fixed ports with `pnpm --filter @splitch/control-panel
 * test:e2e`, so do not run both at once in one container.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { localDevServices } from "../apps/control-panel/local-dev-cloudflare.ts";
import { sandboxPreview, startServiceProxies } from "./local-dev-runtime.mjs";
import {
  localE2eMemberSession,
  localE2eNewcomerSession,
  localE2eSession,
} from "./local-e2e-fixtures.mjs";
import { wranglerBin } from "./local-e2e-fleet-config.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const persistPath = resolve(repoRoot, "test-results/control-panel-e2e-state");
const logPath = resolve(repoRoot, "test-results/local-dev-panel.log");
const PANEL = { host: "127.0.0.1", port: 18793 };
const PANEL_ORIGIN = `http://${PANEL.host}:${PANEL.port}`;
const SESSION_SECONDS = 24 * 60 * 60;
const FLEET_PACKAGES = [
  "@splitch/control-panel",
  ...Object.values(localDevServices).map(([, app]) => `@splitch/${app}`),
];

const PERSONAS = {
  owner: {
    label: "Owner",
    detail: "owner@acme-labs.e2e: owner of acme-labs and checkout-api",
    session: localE2eSession,
  },
  member: {
    label: "Member",
    detail: "member@acme-labs.e2e: plain member of acme-labs",
    session: localE2eMemberSession,
  },
  newcomer: {
    label: "Newcomer",
    detail: "a signed-in User with no Organization yet",
    session: localE2eNewcomerSession,
  },
};

function mintSession(persona) {
  const token = `spl_${randomBytes(32).toString("hex")}`;
  const key = `session:${createHash("sha256").update(token).digest("hex")}`;
  const value = persona.session(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const result = spawnSync(
    process.execPath,
    [
      wranglerBin,
      "kv",
      "key",
      "put",
      key,
      JSON.stringify(value),
      "--binding",
      "SESSION_STORE",
      "--local",
      "--config",
      "apps/control-panel/wrangler.jsonc",
      "--persist-to",
      persistPath,
    ],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "true" } },
  );
  if (result.status !== 0) {
    throw new Error(`could not write the session to SESSION_STORE\n${result.stderr}`);
  }
  return token;
}

function publicOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${req.headers["x-forwarded-host"] ?? req.headers.host}`;
}

export function safeReturnTo(raw) {
  return raw?.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/\\") ? raw : "/";
}

function loginPage(returnTo) {
  const links = Object.entries(PERSONAS)
    .map(
      ([name, persona]) =>
        `<li><a href="/__dev/login/${name}?returnTo=${encodeURIComponent(returnTo)}">${persona.label}</a> <span>${persona.detail}</span></li>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>splitch dev login</title>
<style>body{font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}li{margin:.75rem 0}span{color:#666}</style>
<h1>splitch local dev login</h1>
<p>Local fixture data only. Each sign-in mints a fresh session that lasts 24 hours.</p>
<ul>${links}</ul>`;
}

function handleDevLogin(req, res, url) {
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const name = url.pathname.slice("/__dev/login/".length);
  if (url.pathname === "/__dev/login" || url.pathname === "/__dev/login/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(loginPage(returnTo));
    return;
  }
  const persona = Object.hasOwn(PERSONAS, name) ? PERSONAS[name] : undefined;
  if (!persona) {
    res.writeHead(404, { "content-type": "text/plain" }).end(`unknown persona: ${name}\n`);
    return;
  }
  const token = mintSession(persona);
  // Browsers drop `Secure` cookies over plain HTTP on a non-loopback host.
  const secure = publicOrigin(req).startsWith("https:") ? "; Secure" : "";
  res.writeHead(302, {
    "cache-control": "no-store",
    location: returnTo,
    "set-cookie": `__session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`,
  });
  res.end();
}

export function upstreamHeaders(req) {
  // The dev server builds `request.url` from `Host` plus `x-forwarded-proto`,
  // so drop the forwarded pair and the panel always sees PANEL_ORIGIN. Its
  // same-origin checks compare Origin with that URL: only this gateway's own
  // Origin is mapped onto it, so any other Origin is still rejected upstream.
  const { "x-forwarded-host": _host, "x-forwarded-proto": _proto, ...headers } = req.headers;
  headers.host = `${PANEL.host}:${PANEL.port}`;
  if (headers.origin === publicOrigin(req)) headers.origin = PANEL_ORIGIN;
  return headers;
}

export function rewriteLocation(location) {
  if (!location) return location;
  if (location.startsWith(PANEL_ORIGIN)) location = location.slice(PANEL_ORIGIN.length) || "/";
  if (location.startsWith("/auth/login")) return location.replace("/auth/login", "/__dev/login");
  // Sign-out sends the browser to WorkOS's logout URL; there is no WorkOS here.
  if (/^https:\/\/[^/]*workos\.com\//.test(location)) return "/__dev/login";
  return location;
}

function proxy(req, res, service = "") {
  const url = new URL(req.url ?? "/", "http://gateway");
  if (url.pathname.startsWith("/__dev/login")) {
    try {
      handleDevLogin(req, res, url);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`${error.message}\n`);
    }
    return;
  }
  if (url.pathname === "/auth/login") {
    res.writeHead(302, { location: `/__dev/login${url.search}`, "cache-control": "no-store" });
    res.end();
    return;
  }
  const upstream = httpRequest(
    {
      ...PANEL,
      method: req.method,
      path: service ? `/__dev/services/${service}${req.url}` : req.url,
      headers: upstreamHeaders(req),
    },
    (upstreamRes) => {
      const headers = { ...upstreamRes.headers };
      if (headers.location) headers.location = rewriteLocation(headers.location);
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`control panel unreachable: ${error.message}\n`);
  });
  req.pipe(upstream);
}

function upgradeRequestHead(req) {
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [name, value] of Object.entries(upstreamHeaders(req))) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function proxyUpgrade(req, socket, head) {
  const upstream = connect(PANEL.port, PANEL.host, () => {
    upstream.write(upgradeRequestHead(req));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

async function waitForFleet(runId, fleet) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (fleet.exitCode !== null) throw new Error(`fleet exited ${fleet.exitCode}; see ${logPath}`);
    try {
      const response = await fetch(`http://127.0.0.1:18799/health?run=${runId}`);
      if (response.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`fleet did not become healthy in 180s; see ${logPath}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "18800" },
      share: { type: "boolean", default: false },
    },
  });
  const port = Number(values.port);
  const runId = `dev-${randomBytes(4).toString("hex")}`;

  // The Workers import workspace packages through their built `dist/`, the
  // same `^build` dependency `test:e2e` declares. Turbo caches it after one run.
  console.log("local-dev-panel: building workspace dependencies");
  const build = spawnSync(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "build",
      "--concurrency=2",
      "--output-logs=errors-only",
      ...FLEET_PACKAGES.map((name) => `--filter=${name}^...`),
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("building workspace dependencies failed");

  mkdirSync(resolve(repoRoot, "test-results"), { recursive: true });
  const log = createWriteStream(logPath);
  console.log(`local-dev-panel: booting the seeded fleet (log: ${logPath})`);
  const fleet = spawn("node", ["scripts/local-e2e-fleet.mjs", runId], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      SPLITCH_LOCAL_DEV_FLEET: "true",
      SPLITCH_LOCAL_DEV_GATEWAY_PORT: String(port),
      ACCESS_TOKEN_SECRET: JSON.stringify({
        ...generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          format: "jwk",
        }),
        kid: "local-e2e-analysis",
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  fleet.stdout.pipe(log);
  fleet.stderr.pipe(log);

  let shared = false;
  const stopFleet = () => {
    if (process.platform === "win32") fleet.kill("SIGTERM");
    else {
      try {
        process.kill(-fleet.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  };
  const cleanup = () => {
    if (shared) {
      shared = false;
      sandboxPreview(port, false);
    }
    stopFleet();
  };
  const shutdown = () => {
    cleanup();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);
  process.once("exit", cleanup);
  fleet.once("exit", (code) => {
    cleanup();
    console.error(`local-dev-panel: fleet exited (${code}); see ${logPath}`);
    process.exit(1);
  });

  try {
    await waitForFleet(runId, fleet);
    await startServiceProxies(proxy, PANEL_ORIGIN);
    const gateway = createServer(proxy);
    gateway.on("upgrade", proxyUpgrade);
    await new Promise((done, reject) => {
      gateway.once("error", reject);
      gateway.listen(port, "127.0.0.1", done);
    });
    console.log(`local-dev-panel: ready at http://127.0.0.1:${port}/__dev/login`);

    if (values.share) {
      sandboxPreview(port, true);
      shared = true;
    }
  } catch (error) {
    cleanup();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(`local-dev-panel: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
