import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { build } from "esbuild";
import { Log, LogLevel, Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("keeps bound parameters out of native scheduled exceptions after reporting a retention fault", async () => {
  const canary = "retentionboundprivatecanary";
  const bundle = await build({
    stdin: {
      contents: `
        import { runDeliveryRetention } from './src/delivery-retention.ts';
        import { DrizzleQueryError } from '../../packages/db/node_modules/drizzle-orm/errors.js';
        export default {
          scheduled(event, env, ctx) {
            const DB = {
              prepare() {
                throw new DrizzleQueryError('select ?', ['${canary}'], new Error('D1_ERROR: internal error'));
              }
            };
            ctx.waitUntil(runDeliveryRetention({ DB }, event, ctx));
          }
        };
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "delivery-retention-runtime-worker.ts",
      loader: "ts",
    },
    bundle: true,
    // Match Wrangler's name preservation, verified by drizzle-query-bundle.test.ts.
    keepNames: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  const output: string[] = [];
  const records =
    Promise.withResolvers<
      { outcome: string; exceptions: { name: string; message: string }[]; logs: unknown[] }[]
    >();
  class RuntimeLog extends Log {
    override log(message: string) {
      output.push(message);
    }
  }
  const mf = new Miniflare({
    workers: [
      {
        name: "retention",
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2026-06-21",
        compatibilityFlags: ["nodejs_compat"],
        tails: ["records"],
      },
      {
        name: "records",
        modules: true,
        compatibilityDate: "2026-06-21",
        script: `export default {
          async tail(events, env) {
            await env.RECORDS.fetch('https://records.test', {
              method: 'POST', body: JSON.stringify(events)
            });
          }
        };`,
        serviceBindings: {
          RECORDS: async (request) => {
            records.resolve(await request.json());
            return new Response(null, { status: 204 });
          },
        },
      },
    ],
    log: new RuntimeLog(LogLevel.DEBUG),
    handleRuntimeStdio(stdout, stderr) {
      for (const stream of [stdout, stderr]) {
        stream.on("data", (chunk) => output.push(chunk.toString()));
      }
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const worker = await mf.getWorker("retention");
    const result = await worker.scheduled({ scheduledTime: new Date(), cron: "0 8 * * *" });
    const events = await Promise.race([
      records.promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Native exception records did not arrive")),
          5_000,
        );
      }),
    ]);
    expect(result.outcome).toBe("exception");
    expect(events).toHaveLength(1);
    expect(events[0].exceptions).toEqual([
      expect.objectContaining({ name: "Error", message: "delivery_retention_failed" }),
    ]);
    const options = { showHidden: true, depth: null, maxStringLength: null, maxArrayLength: null };
    const reported = inspect(events[0].logs, options);
    expect(reported).toContain("delivery_retention_failed");
    expect(reported).toContain("Failed query: select ?");
    expect(reported).toContain("D1_ERROR: internal error");
    const sinks = inspect([events, output], options);
    expect(sinks).not.toContain(canary);
    expect(sinks).not.toContain("params:");
    const native = inspect(events[0].exceptions, options);
    expect(native).not.toContain("select ?");
    expect(native).not.toContain("D1_ERROR");
  } finally {
    clearTimeout(timeout);
    await mf.dispose();
  }
});
