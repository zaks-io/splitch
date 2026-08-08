import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableExposureRedemptionClaimStore,
  type ExposureRedemptionClaimNamespace,
} from "./exposure-redemption-claim";
import {
  type ExposureRedemptionClaimDoContext,
  handleExposureRedemptionClaimFetch,
  runExposureRedemptionClaimAlarm,
} from "./exposure-redemption-do-handler";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

/**
 * Production DO handler + Miniflare worker built from real TypeScript sources.
 * Dropping `blockConcurrencyWhile` or HTTP/method guards fails these tests.
 */

function memoryCtx(): ExposureRedemptionClaimDoContext {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async <T>(key: string) => map.get(key) as T | undefined,
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
      delete: async (key: string | string[]) => {
        if (Array.isArray(key)) for (const k of key) map.delete(k);
        else map.delete(key);
      },
      list: async <T>() => new Map(Array.from(map.entries()) as Array<[string, T]>),
      getAlarm: async () => alarm,
      setAlarm: async (scheduledTime: number) => {
        alarm = scheduledTime;
      },
    } as unknown as DurableObjectStorage,
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`https://exposure-redemption-claim.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const claimBody = { exposureId: "e1", ticketFingerprint: "fp", nowMs: 1_000 };

describe("handleExposureRedemptionClaimFetch (production handler)", () => {
  it("runs claim/release/markSealed/acknowledge inside blockConcurrencyWhile", async () => {
    const ctx = memoryCtx();
    let gated = 0;
    ctx.blockConcurrencyWhile = async <T>(fn: () => Promise<T>) => {
      gated += 1;
      return fn();
    };
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody))).json(),
    ).toEqual({
      status: "acquired",
    });
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody))).json(),
    ).toEqual({
      status: "busy",
    });
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, post("/markSealed", claimBody))).status,
    ).toBe(200);
    expect(
      await (await handleExposureRedemptionClaimFetch(ctx, post("/acknowledge", claimBody))).json(),
    ).toEqual({
      status: "accepted",
    });
    expect(gated).toBeGreaterThanOrEqual(4);
  });

  it("rejects non-POST, unknown paths, and malformed bodies", async () => {
    const ctx = memoryCtx();
    expect(
      (
        await handleExposureRedemptionClaimFetch(
          ctx,
          new Request("https://do/claim", { method: "GET" }),
        )
      ).status,
    ).toBe(404);
    expect((await handleExposureRedemptionClaimFetch(ctx, post("/other", claimBody))).status).toBe(
      404,
    );
    expect(
      (await handleExposureRedemptionClaimFetch(ctx, post("/claim", { exposureId: "e1" }))).status,
    ).toBe(400);
  });

  it("does not list the full keyspace on the claim hot path", async () => {
    const ctx = memoryCtx();
    let listed = 0;
    (ctx.storage as unknown as { list: () => Promise<Map<string, unknown>> }).list = async () => {
      listed += 1;
      return new Map();
    };
    await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, post("/markSealed", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, post("/acknowledge", claimBody));
    expect(listed).toBe(0);
  });

  it("release clears pending so a later claim can acquire", async () => {
    const ctx = memoryCtx();
    await handleExposureRedemptionClaimFetch(ctx, post("/claim", claimBody));
    await handleExposureRedemptionClaimFetch(ctx, post("/release", claimBody));
    expect(
      await (
        await handleExposureRedemptionClaimFetch(
          ctx,
          post("/claim", { ...claimBody, exposureId: "e2", nowMs: 2 }),
        )
      ).json(),
    ).toEqual({ status: "acquired" });
  });

  it("arms a storage alarm on claim and re-arms from alarm()", async () => {
    const ctx = memoryCtx();
    const now = Date.now();
    await handleExposureRedemptionClaimFetch(ctx, post("/claim", { ...claimBody, nowMs: now }));
    expect(await ctx.storage.getAlarm()).toBe(now + 24 * 60 * 60 * 1000);
    const nearer = now + 60_000;
    await ctx.storage.put("exposure:old", {
      ticketFingerprint: "x",
      delivery: "pending",
      expiresAt: now - 1,
    });
    await ctx.storage.put("exposure:live", {
      ticketFingerprint: "y",
      delivery: "pending",
      expiresAt: nearer,
    });
    await runExposureRedemptionClaimAlarm(ctx.storage);
    expect(await ctx.storage.get("exposure:old")).toBeUndefined();
    expect(await ctx.storage.getAlarm()).toBe(nearer);
  });

  it("returns 409 when acknowledge targets a missing claim (fail-loud)", async () => {
    expect(
      (await handleExposureRedemptionClaimFetch(memoryCtx(), post("/acknowledge", claimBody)))
        .status,
    ).toBe(409);
  });
});

describe("DurableExposureRedemptionClaimStore HTTP guards", () => {
  it("throws when the Durable Object returns a non-OK HTTP status (even with a success-shaped body)", async () => {
    const namespace: ExposureRedemptionClaimNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ status: "acquired" }), { status: 500 }),
      }),
    };
    await expect(
      new DurableExposureRedemptionClaimStore(namespace).claim({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: "e1",
        ticketFingerprint: "fp",
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws on acknowledge when the Durable Object returns HTTP 409 for a missing claim", async () => {
    const namespace: ExposureRedemptionClaimNamespace = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ error: "missing claim" }), { status: 409 }),
      }),
    };
    await expect(
      new DurableExposureRedemptionClaimStore(namespace).acknowledge({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: "e1",
        ticketFingerprint: "fp",
      }),
    ).rejects.toThrow(/HTTP 409/);
  });
});

describe("ExposureRedemptionClaimDurableObject via Miniflare (real sources)", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("serializes concurrent same-ticket claims to one acquired and one busy", async () => {
    mf = new Miniflare({
      modules: true,
      script: bundleProductionDoWorker(),
      compatibilityDate: "2025-11-01",
      durableObjects: { CLAIMS: "ExposureRedemptionClaimDurableObject" },
    });
    const body = { exposureId: "exp-shared", ticketFingerprint: "fp-shared", nowMs: Date.now() };
    const [a, b] = await Promise.all([
      mf.dispatchFetch("http://localhost/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      mf.dispatchFetch("http://localhost/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ]);
    const statuses = [
      ((await a.json()) as { status: string }).status,
      ((await b.json()) as { status: string }).status,
    ].sort();
    expect(statuses).toEqual(["acquired", "busy"]);
  });

  it("scopes independent App+Environment DO stubs", async () => {
    mf = new Miniflare({
      modules: true,
      script: bundleProductionDoWorker(),
      compatibilityDate: "2025-11-01",
      durableObjects: { CLAIMS: "ExposureRedemptionClaimDurableObject" },
    });
    const store = new DurableExposureRedemptionClaimStore(
      (await mf.getDurableObjectNamespace("CLAIMS")) as unknown as ExposureRedemptionClaimNamespace,
    );
    await expect(
      store.claim({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: "e1",
        ticketFingerprint: "shared",
      }),
    ).resolves.toEqual({ status: "acquired" });
    await expect(
      store.claim({
        appId: "app-other",
        environmentId: ENVIRONMENT_ID,
        exposureId: "e1",
        ticketFingerprint: "shared",
      }),
    ).resolves.toEqual({ status: "acquired" });
  });
});

/** Transpile production claim core + handler into a Miniflare worker script. */
function bundleProductionDoWorker(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const core = readFileSync(join(root, "exposure-redemption-claim-core.ts"), "utf8");
  const handler = readFileSync(join(root, "exposure-redemption-do-handler.ts"), "utf8").replace(
    /^import[\s\S]*?from ["']\.\/exposure-redemption-claim-core["'];?\s*/m,
    "",
  );
  const stripExport = (source: string) =>
    source.replace(/^export /gm, "").replace(/^export \{[\s\S]*?\};?\s*/gm, "");
  return ts.transpileModule(
    `
${stripExport(core)}
${stripExport(handler)}
export class ExposureRedemptionClaimDurableObject {
  constructor(state) { this.ctx = state; }
  async fetch(request) { return handleExposureRedemptionClaimFetch(this.ctx, request); }
  async alarm() { await runExposureRedemptionClaimAlarm(this.ctx.storage); }
}
export default {
  async fetch(request, env) {
    return env.CLAIMS.get(env.CLAIMS.idFromName("test")).fetch(request);
  },
};
`,
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
      fileName: "exposure-redemption-do.mf.ts",
    },
  ).outputText;
}
