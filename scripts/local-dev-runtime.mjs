import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { localDevServices } from "../apps/control-panel/local-dev-cloudflare.ts";

const repoRoot = resolve(import.meta.dirname, "..");

export function sandboxPreview(port, enable) {
  const result = spawnSync("sbx-preview", [enable ? "open" : "close", String(port)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0 && enable) {
    throw new Error(`sbx-preview failed\n${result.stderr || result.error?.message}`);
  }
  if (enable) {
    const listing = spawnSync("sbx-preview", ["list"], { encoding: "utf8" });
    process.stdout.write(listing.stdout);
  }
}

export async function startServiceProxies(proxy, panelOrigin) {
  for (const [service, [, app, servicePort]] of Object.entries(localDevServices)) {
    const server = createServer((req, res) => proxy(req, res, service));
    await new Promise((done, reject) => {
      server.once("error", reject);
      server.listen(servicePort, "127.0.0.1", done);
    });
    const response = await fetch(`http://127.0.0.1:${servicePort}/health`, {
      signal: AbortSignal.timeout(60_000),
    });
    const health = await response.json();
    if (!response.ok || health.platformTarget !== "local" || health.service !== `splitch-${app}`)
      throw new Error(`${service} failed health check: HTTP ${response.status}`);
  }
  const seeded = await fetch(`${panelOrigin}/__dev/seed`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });
  if (!seeded.ok)
    throw new Error(`Local Flag Configuration publication failed: HTTP ${seeded.status}`);
}
