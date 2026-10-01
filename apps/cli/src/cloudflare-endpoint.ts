import { cloudflareUsage } from "./cloudflare-error.js";
import type { CliDeps } from "./execute-types.js";

const ROUTABLE_ATTEMPTS = 60;
const PROBE_TIMEOUT_MS = 5_000;

export function cliSleep(deps: CliDeps): (milliseconds: number) => Promise<void> {
  return deps.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
}

/**
 * A just-deployed workers.dev hostname answers Cloudflare's own 404 until the
 * route propagates, and Splitch treats a 404 push as terminal. An unsigned POST
 * only earns the integration Worker's own 401 once the route is live, so the
 * first push cannot race the propagation.
 */
export async function waitForWorkerRoutable(endpoint: string, deps: CliDeps): Promise<void> {
  const sleep = cliSleep(deps);
  let last = "no response";
  for (let attempt = 0; attempt < ROUTABLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(1_000);
    const unroutable = await probe(endpoint, deps);
    if (unroutable === null) return;
    last = unroutable;
  }
  throw cloudflareUsage(
    `The deployed Cloudflare Worker at ${endpoint} did not become reachable after ${ROUTABLE_ATTEMPTS} attempts one second apart (last response: ${last})`,
  );
}

/** `null` once the Worker itself answers; otherwise what answered instead. */
async function probe(endpoint: string, deps: CliDeps): Promise<string | null> {
  try {
    const response = await (deps.fetch ?? fetch)(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 && (await isWorkerRejection(response))) return null;
    await response.body?.cancel();
    return `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}

async function isWorkerRejection(response: Response): Promise<boolean> {
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return body?.code === "UNAUTHORIZED";
}
