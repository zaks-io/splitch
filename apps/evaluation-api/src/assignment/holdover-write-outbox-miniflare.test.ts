import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assignmentKey } from "@splitch/contracts";
import { Miniflare } from "miniflare";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableHoldoverWriteCoordinator,
  type HoldoverWriteOutboxNamespace,
} from "./holdover-write-outbox";
import { holdoverWriteOutboxName } from "./holdover-write-outbox-core";

/**
 * Miniflare boundary: real HoldoverWriteOutbox DO + Assignment Store DO.
 * Forces the first Assignment Store put to fail, accepts durable ownership,
 * drives the outbox alarm, then proves the holdover is readable from KV.
 */

const PUT = {
  appId: "app-A",
  experimentId: "exp-checkout",
  idType: "user",
  targetingKeyHash: "hash-entity-1",
  runId: "run-42",
  variant: "treatment",
} as const;

describe("HoldoverWriteOutboxDurableObject via Miniflare (real boundary)", () => {
  let mf: Miniflare | undefined;

  afterEach(async () => {
    await mf?.dispose();
    mf = undefined;
  });

  it("owns retry after first Assignment Store failure and becomes readable after alarm", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstPut: true });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);

    const first = await coordinator.ensure(PUT);
    expect(first).toEqual({ status: "owned" });

    const key = assignmentKey(PUT.appId, PUT.idType, PUT.targetingKeyHash);
    const kvBefore = await mf.getKVNamespace("ASSIGNMENTS_KV");
    expect(await kvBefore.get(key)).toBeNull();

    const stub = outboxNs.get(outboxNs.idFromName(holdoverWriteOutboxName(PUT)));
    const alarm = await stub.fetch("https://holdover-write-outbox.local/__test/alarm", {
      method: "POST",
    });
    expect(alarm.status).toBe(200);

    const status = await stub.fetch("https://holdover-write-outbox.local/status");
    expect(await status.json()).toMatchObject({ status: "completed" });

    const kvAfter = await mf.getKVNamespace("ASSIGNMENTS_KV");
    const raw = await kvAfter.get(key);
    expect(raw).toEqual(expect.any(String));
    expect(JSON.parse(raw as string)).toMatchObject({
      data: {
        [PUT.experimentId]: { runId: PUT.runId, variant: PUT.variant },
      },
    });
  });

  it("duplicate ensure after completion does not rewrite and stays completed", async () => {
    mf = await miniflareWithOutboxAndAssignmentStore({ failFirstPut: false });
    const outboxNs = (await mf.getDurableObjectNamespace(
      "HOLDOVER_WRITE_OUTBOX",
    )) as unknown as HoldoverWriteOutboxNamespace;
    const coordinator = new DurableHoldoverWriteCoordinator(outboxNs);
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
    await expect(coordinator.ensure(PUT)).resolves.toEqual({ status: "completed" });
  });
});

async function miniflareWithOutboxAndAssignmentStore(options: {
  failFirstPut: boolean;
}): Promise<Miniflare> {
  return new Miniflare({
    modules: true,
    script: bundleWorker(options.failFirstPut),
    compatibilityDate: "2026-06-21",
    compatibilityFlags: ["nodejs_compat"],
    kvNamespaces: { ASSIGNMENTS_KV: "assignments" },
    durableObjects: {
      ASSIGNMENT_STORE_WRITER: { className: "AssignmentStoreDurableObject" },
      HOLDOVER_WRITE_OUTBOX: { className: "HoldoverWriteOutboxDurableObject" },
    },
  });
}

function bundleWorker(failFirstPut: boolean): string {
  const root = dirname(fileURLToPath(import.meta.url));
  const core = readSource(join(root, "holdover-write-outbox-core.ts"));
  const outbox = readSource(join(root, "holdover-write-outbox.ts"))
    .replace(/^import[\s\S]*?from ["']\.\/assignment-store["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/kv-assignment-store["'];?\s*/m, "");
  const doClass = readSource(join(root, "holdover-write-outbox-do.ts"))
    .replace(/^import \{ DurableObject \} from "cloudflare:workers";\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox["'];?\s*/m, "")
    .replace(/^import[\s\S]*?from ["']\.\/holdover-write-outbox-core["'];?\s*/m, "");

  const assignmentDo = `
export class AssignmentStoreDurableObject extends DurableObject {
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/put") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const input = await request.json();
    const gate = await this.ctx.storage.get("fail-once-gate");
    if (${failFirstPut ? "true" : "false"} && gate !== "passed") {
      await this.ctx.storage.put("fail-once-gate", "passed");
      return new Response("forced failure", { status: 503 });
    }
    const storageKey = "assignment:" + input.experimentId;
    const existing = await this.ctx.storage.get(storageKey);
    if (existing === undefined) {
      await this.ctx.storage.put(storageKey, input);
    }
    const key = "assignment:" + input.appId + ":" + input.idType + ":" + input.targetingKeyHash;
    const currentRaw = await this.env.ASSIGNMENTS_KV.get(key);
    const current = currentRaw ? JSON.parse(currentRaw).data : {};
    if (current[input.experimentId] === undefined) {
      current[input.experimentId] = { runId: input.runId, variant: input.variant };
      await this.env.ASSIGNMENTS_KV.put(key, JSON.stringify({ schemaVersion: 1, data: current }));
    }
    return Response.json({
      status: existing === undefined ? "stored" : "existing",
      assignment: { runId: input.runId, variant: input.variant },
    });
  }
}
`;

  const stubs = `
function assignmentWriterName(input) {
  return input.appId + ":" + input.idType + ":" + input.targetingKeyHash;
}
`;

  const stripExport = (source: string) =>
    source.replace(/^export \{[\s\S]*?\};?\s*/gm, "").replace(/^export /gm, "");

  return ts.transpileModule(
    `
import { DurableObject } from "cloudflare:workers";
${stubs}
${stripExport(core)}
${stripExport(outbox)}
${doClass}
${assignmentDo}
const __prodFetch = HoldoverWriteOutboxDurableObject.prototype.fetch;
HoldoverWriteOutboxDurableObject.prototype.fetch = async function (request) {
  const url = new URL(request.url);
  if (url.pathname === "/__test/alarm" && request.method === "POST") {
    await this.alarm();
    return Response.json({ ok: true });
  }
  return __prodFetch.call(this, request);
};
export default {
  async fetch() {
    return new Response("harness", { status: 200 });
  },
};
`,
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
      },
      fileName: "holdover-write-outbox.mf.ts",
    },
  ).outputText;
}

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}
