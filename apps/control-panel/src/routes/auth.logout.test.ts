import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlPanelBindings } from "#lib/bindings";
import { createSession } from "#lib/session";
import { loadSessionFromRequest } from "#lib/session-refresh";
import { MemoryKv, sessionPrincipal } from "#lib/session-test-harness";

/**
 * The enforcement point, not the helper: SPL-227 was a route that hung a
 * session-destroying action off `GET`, so the proof has to run the route's own
 * handlers. Each case asserts what happened to the session itself — a status
 * code alone would still pass if the refusal ran after `destroySession`.
 */

const kv = new MemoryKv();
const bindings: ControlPanelBindings = {
  DB: {} as D1Database,
  SESSION_STORE: kv.namespace(),
  WORKOS_API_KEY: "sk_test",
  WORKOS_CLIENT_ID: "client_test",
  AUTH_API_ORIGIN: "https://auth.splitch.test",
  EVALUATION_API_ORIGIN: "https://edge.splitch.test",
};

vi.mock("cloudflare:workers", () => ({
  env: bindings,
}));

const { Route } = await import("./auth.logout");

const LOGOUT_URL = "https://panel.splitch.test/auth/logout";
const SAME_ORIGIN = "https://panel.splitch.test";

// TanStack's server handler map is typed for framework invocation only; these
// tests call the handlers directly with the request they receive at runtime.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
const handlers = (Route.options as any).server.handlers;

async function signIn(): Promise<string> {
  const created = await createSession(kv.namespace(), sessionPrincipal());
  return created.cookie.split(";")[0] ?? "";
}

/** What every authenticated route does with the cookie it was handed. */
async function authenticatedRequestSucceeds(cookie: string): Promise<boolean> {
  const loaded = await loadSessionFromRequest(
    bindings,
    new Request("https://panel.splitch.test/acme", { headers: { cookie } }),
  );
  return loaded.ok;
}

function postLogout(headers: Record<string, string> = {}): Promise<Response> {
  return handlers.POST({
    request: new Request(LOGOUT_URL, { headers, method: "POST" }),
  });
}

describe("/auth/logout requires an unsafe method", () => {
  beforeEach(() => {
    kv.store.clear();
  });

  it("refuses a GET without touching the session", async () => {
    const cookie = await signIn();

    const response = await handlers.GET({
      request: new Request(LOGOUT_URL, { headers: { cookie } }),
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toContain("POST /auth/logout");

    expect(kv.store.size).toBe(1);
    await expect(authenticatedRequestSucceeds(cookie)).resolves.toBe(true);
  });

  it("destroys the session on a same-origin POST and redirects as before", async () => {
    const cookie = await signIn();

    const response = await postLogout({ cookie, origin: SAME_ORIGIN });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("workos_session_1");
    expect(response.headers.get("set-cookie")).toContain("__session=");
    expect(response.headers.get("cache-control")).toBe("no-store");

    expect(kv.store.size).toBe(0);
    await expect(authenticatedRequestSucceeds(cookie)).resolves.toBe(false);
  });

  it("still redirects home when the session was already gone", async () => {
    const response = await postLogout({ origin: SAME_ORIGIN });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://panel.splitch.test/");
  });
});

describe("/auth/logout rejects cross-origin form POSTs before destroy", () => {
  beforeEach(() => {
    kv.store.clear();
  });

  it.each([
    ["cross-site evil Origin", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    [
      "same-site sibling Origin",
      { origin: "https://auth.splitch.dev", "sec-fetch-site": "same-site" },
    ],
    ["missing Origin", {}],
  ])("returns 403 for %s without touching the session", async (_name, headers) => {
    const cookie = await signIn();

    const response = await postLogout({ cookie, ...headers });

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(kv.store.size).toBe(1);
    await expect(authenticatedRequestSucceeds(cookie)).resolves.toBe(true);
  });
});

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry) || entry.includes(".test.")) return [];
    return [path];
  });
}

/**
 * The rendered half of the same contract: a single anchor to the logout route
 * anywhere in the panel restores the prefetch bug, because a `SameSite=Lax`
 * cookie rides along on a speculative top-level GET.
 */
describe("no sign-out affordance is a link", () => {
  it("renders no anchor or router target pointing at the logout route", () => {
    const offenders: string[] = [];
    const target = /(?:href|to)=["'{][^\n"']*(?:\/auth\/logout|LOGOUT_PATH)/g;

    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(target)) {
        offenders.push(`${file.slice(SRC.length)}: ${match[0].trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
