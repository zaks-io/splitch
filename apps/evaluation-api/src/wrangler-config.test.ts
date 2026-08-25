import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();
const targets = [
  ["local", config],
  ["shared-preview", config.env?.["shared-preview"]],
  ["production", config.env?.production],
] as const;

describe("Evaluation Worker service bindings", () => {
  it.each(targets)("hands dependencies their narrow service bindings for %s", (_target, target) => {
    expect(target?.services).toEqual([
      {
        binding: "EVENT_INGEST",
        service: expect.any(String),
        entrypoint: "EvaluationEntrypoint",
      },
      {
        binding: "CONTROL_PLANE_API",
        service: expect.any(String),
        entrypoint: "EvaluationEntrypoint",
      },
    ]);
  });

  it.each(targets)("subscribes to the Config Store DO for %s", (targetName, target) => {
    const binding = target?.durable_objects?.bindings?.find(
      (candidate) => candidate.name === "CONFIG_STORE_WRITER",
    );
    expect(binding).toEqual({
      name: "CONFIG_STORE_WRITER",
      class_name: "ConfigStoreDurableObject",
      script_name:
        targetName === "shared-preview"
          ? "splitch-control-plane-api-shared-preview"
          : "splitch-control-plane-api",
    });
  });

  it.each(targets)("binds the holdover write outbox DO for %s", (_target, target) => {
    const binding = target?.durable_objects?.bindings?.find(
      (candidate) => candidate.name === "HOLDOVER_WRITE_OUTBOX",
    );
    expect(binding).toEqual({
      name: "HOLDOVER_WRITE_OUTBOX",
      class_name: "HoldoverWriteOutboxDurableObject",
    });
    expect(
      target?.migrations?.some(
        (migration) =>
          migration.tag === "v4_holdover_write_outbox" &&
          migration.new_sqlite_classes?.includes("HoldoverWriteOutboxDurableObject"),
      ),
    ).toBe(true);
  });

  it.each(targets)("binds the holdover write App inventory DO for %s", (_target, target) => {
    const binding = target?.durable_objects?.bindings?.find(
      (candidate) => candidate.name === "HOLDOVER_WRITE_APP_INVENTORY",
    );
    expect(binding).toEqual({
      name: "HOLDOVER_WRITE_APP_INVENTORY",
      class_name: "HoldoverWriteAppInventoryDurableObject",
    });
    expect(
      target?.migrations?.some(
        (migration) =>
          migration.tag === "v5_holdover_write_app_inventory" &&
          migration.new_sqlite_classes?.includes("HoldoverWriteAppInventoryDurableObject"),
      ),
    ).toBe(true);
  });

  /**
   * The binding is shared, so the entrypoint behind it has to answer every sink
   * this Worker addresses. A second binding would only give the same caller a
   * second identity; the fix for a new sink is teaching that entrypoint.
   *
   * Only this direction is a source read, and only the internal sinks: it catches
   * a URL built here that Event Ingest never routes. Whether the entrypoint
   * recognises each delegated operation is answered at runtime, by the registry
   * sweep in `apps/event-ingest-api/src/evaluation-entrypoint.test.ts`.
   */
  it("routes every internal sink the Evaluation Worker addresses", () => {
    const routed = routedInternalPaths();

    for (const path of internalSinkPaths()) {
      expect([...routed], `${path} is not routed by EvaluationEntrypoint`).toContain(path);
    }
  });
});

/**
 * The paths Event Ingest's `internalRoutes` table actually dispatches on, read
 * off the table itself with comments stripped: a path named in a comment is not
 * a route, and matching the whole file would let one satisfy this gate.
 */
function routedInternalPaths(): Set<string> {
  const source = stripComments(
    readFileSync(
      fileURLToPath(new URL("../../event-ingest-api/src/index.ts", import.meta.url)),
      "utf8",
    ),
  );
  const start = source.indexOf("const internalRoutes");
  const end = source.indexOf("\n};", start);
  if (start === -1 || end === -1) throw new Error("event-ingest-api has no internalRoutes table");
  const paths = new Set<string>();
  for (const [, key] of source.slice(start, end).matchAll(/\[(\w+)\]\s*:/g)) {
    const declaration = source.match(new RegExp(`const ${key} = "([^"]+)"`));
    if (!declaration?.[1]) throw new Error(`internalRoutes key ${key} declares no path`);
    paths.add(declaration[1]);
  }
  return paths;
}

/** The token-authenticated sinks, read off the URLs this Worker's own source builds. */
function internalSinkPaths(): readonly string[] {
  const sinkDir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(sinkDir)
    .filter((file) => file.endsWith(".ts") && !file.includes(".test") && !file.includes("fixtures"))
    .map((file) => readFileSync(`${sinkDir}${file}`, "utf8"));
  const paths = new Set(
    sources
      .flatMap((source) => [...source.matchAll(/new URL\("(\/api\/internal\/[^"]+)"/g)])
      .flatMap(([, path]) => (path ? [path] : [])),
  );
  expect(paths.size).toBeGreaterThan(1);
  return [...paths];
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

interface WranglerTarget {
  durable_objects?: {
    bindings?: Array<{ name?: string; class_name?: string; script_name?: string }>;
  };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[]; new_classes?: string[] }>;
  env?: Record<string, WranglerTarget | undefined>;
  services?: Array<{ binding?: string; service?: string; entrypoint?: string }>;
}

function readWranglerConfig(): WranglerTarget {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(parsed.error.messageText.toString());
  return parsed.config as WranglerTarget;
}
