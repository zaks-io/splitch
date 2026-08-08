import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routesDelegatedBy } from "@splitch/contracts";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();
const targets = [
  ["local", config],
  ["shared-preview", config.env?.["shared-preview"]],
  ["production", config.env?.production],
] as const;

describe("Evaluation Worker service bindings", () => {
  it.each(targets)("hands Event Ingest exactly one binding for %s", (_target, target) => {
    expect(target?.services).toEqual([
      {
        binding: "EVENT_INGEST",
        service: expect.any(String),
        entrypoint: "EvaluationEntrypoint",
      },
    ]);
  });

  /**
   * The binding is shared, so the entrypoint behind it has to answer every
   * operation this Worker sends over it. A second binding would only give the
   * same caller a second identity; the fix for a new operation is teaching this
   * entrypoint, and this test is what says so.
   */
  it("routes every operation the Evaluation Worker sends over that binding", () => {
    const entrypointSource = readFileSync(
      fileURLToPath(new URL("../../event-ingest-api/src/index.ts", import.meta.url)),
      "utf8",
    );

    for (const path of delegatedOperationPaths()) {
      expect(entrypointSource, `${path} is not routed by EvaluationEntrypoint`).toContain(
        `"${path}"`,
      );
    }
  });
});

/** Every Event Ingest path this Worker addresses: internal sinks plus delegated routes. */
function delegatedOperationPaths(): readonly string[] {
  const paths = new Set<string>(internalSinkPaths());
  for (const route of routesDelegatedBy("evaluation-api")) {
    if (route.owner === "event-ingest-api") paths.add(route.path);
  }
  expect(paths.size).toBeGreaterThan(1);
  return [...paths];
}

/** The token-authenticated sinks, read off the URLs this Worker's own source builds. */
function internalSinkPaths(): string[] {
  const sinkDir = fileURLToPath(new URL(".", import.meta.url));
  const sources = readdirSync(sinkDir)
    .filter((file) => file.endsWith(".ts") && !file.includes(".test") && !file.includes("fixtures"))
    .map((file) => readFileSync(`${sinkDir}${file}`, "utf8"));
  return sources
    .flatMap((source) => [...source.matchAll(/new URL\("(\/api\/internal\/[^"]+)"/g)])
    .flatMap(([, path]) => (path ? [path] : []));
}

interface WranglerTarget {
  env?: Record<string, WranglerTarget | undefined>;
  services?: Array<{ binding?: string; service?: string; entrypoint?: string }>;
}

function readWranglerConfig(): WranglerTarget {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(parsed.error.messageText.toString());
  return parsed.config as WranglerTarget;
}
