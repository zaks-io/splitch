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
import { EXPOSURE_REDEMPTION_PENDING_LEASE_MS } from "./exposure-redemption-claim-core";
import { APP_B, ENV_B } from "./exposures-test-fixtures";
import { APP_ID, ENVIRONMENT_ID } from "./sdk-route-test-fixtures";

/**
 * Miniflare / workerd boundary tests against the real
 * `ExposureRedemptionClaimDurableObject` class body (transpiled from source).
 */

describe("ExposureRedemptionClaimDurableObject via Miniflare (real class)", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("serializes concurrent same-ticket claims to one acquired and one busy", async () => {
    mf = await miniflareWithRealDo();
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

  it("returns HTTP 409 for acknowledge-on-missing without aborting sibling claims", async () => {
    mf = await miniflareWithRealDo();
    const store = new DurableExposureRedemptionClaimStore(
      (await mf.getDurableObjectNamespace("CLAIMS")) as unknown as ExposureRedemptionClaimNamespace,
    );
    const ackSettled = store
      .acknowledge({
        appId: APP_ID,
        environmentId: ENVIRONMENT_ID,
        exposureId: "missing",
        ticketFingerprint: "fp",
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.claim({
          appId: APP_ID,
          environmentId: ENVIRONMENT_ID,
          exposureId: `e-${i}`,
          ticketFingerprint: `fp-${i}`,
        }),
      ),
    );
    const ack = await ackSettled;
    expect(ack.ok).toBe(false);
    if (ack.ok) throw new Error("unreachable");
    expect(ack.error).toBeInstanceOf(Error);
    expect((ack.error as Error).message).toMatch(/HTTP 409/);
    expect(claims.every((c) => c.status === "acquired")).toBe(true);
  });

  it("scopes identical exposureId+fingerprint by App and by Environment", async () => {
    mf = await miniflareWithRealDo();
    const store = new DurableExposureRedemptionClaimStore(
      (await mf.getDurableObjectNamespace("CLAIMS")) as unknown as ExposureRedemptionClaimNamespace,
    );
    const shared = { exposureId: "e1", ticketFingerprint: "shared" };
    await expect(
      store.claim({ appId: APP_ID, environmentId: ENVIRONMENT_ID, ...shared }),
    ).resolves.toEqual({ status: "acquired" });
    await expect(
      store.claim({ appId: APP_B, environmentId: ENVIRONMENT_ID, ...shared }),
    ).resolves.toEqual({ status: "acquired" });
    await expect(store.claim({ appId: APP_ID, environmentId: ENV_B, ...shared })).resolves.toEqual({
      status: "acquired",
    });
  });

  it("wires the real DO alarm() to the expiry sweep (and lazy-expires pending leases)", async () => {
    const doSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "exposure-redemption-do.ts"),
      "utf8",
    );
    expect(doSource).toMatch(/override async alarm[\s\S]*runExposureRedemptionClaimAlarm/);
    expect(doSource).not.toMatch(/async alarm\(\)[^{]*\{\s*return;\s*\}/);

    mf = await miniflareWithRealDo();
    const ns = await mf.getDurableObjectNamespace("CLAIMS");
    const stub = ns.get(ns.idFromName(`${APP_ID}\u001f${ENVIRONMENT_ID}`));
    const past = Date.now() - EXPOSURE_REDEMPTION_PENDING_LEASE_MS - 5_000;
    await stub.fetch("https://exposure-redemption-claim.local/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        exposureId: "stale",
        ticketFingerprint: "stale-fp",
        nowMs: past,
      }),
    });
    const reclaim = await stub.fetch("https://exposure-redemption-claim.local/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        exposureId: "stale",
        ticketFingerprint: "stale-fp",
        nowMs: Date.now(),
      }),
    });
    expect(await reclaim.json()).toEqual({ status: "acquired" });
  });

  it("wires EXPOSURE_REDEMPTION_CLAIMS through a required-binding startup check", () => {
    const indexSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
      "utf8",
    );
    expect(indexSource).toMatch(/requiredExposureRedemptionClaimsBinding/);
    expect(indexSource).toMatch(/evaluation-api: EXPOSURE_REDEMPTION_CLAIMS is required/);
  });
});

async function miniflareWithRealDo(): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleRealDoWorker(),
    compatibilityDate: "2025-11-01",
    durableObjects: { CLAIMS: "ExposureRedemptionClaimDurableObject" },
  });
}

/** Transpile production core + handler + real DO class into one Miniflare worker. */
function bundleRealDoWorker(): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const core = readFileSync(join(root, "exposure-redemption-claim-core.ts"), "utf8");
  const handler = readFileSync(join(root, "exposure-redemption-do-handler.ts"), "utf8").replace(
    /^import[\s\S]*?from ["']\.\/exposure-redemption-claim-core["'];?\s*/m,
    "",
  );
  const doClass = readFileSync(join(root, "exposure-redemption-do.ts"), "utf8")
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/exposure-redemption-do-handler["'];?\s*/m, "");
  const stripExport = (source: string) =>
    source.replace(/^export /gm, "").replace(/^export \{[\s\S]*?\};?\s*/gm, "");
  return ts.transpileModule(
    `
import { DurableObject } from "cloudflare:workers";
${stripExport(core)}
${stripExport(handler)}
${doClass}
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
