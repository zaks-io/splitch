import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();

describe("Evaluation Worker service bindings", () => {
  it.each([
    ["local", config],
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("delegates Metric Events through the binding-only entrypoint for %s", (_target, target) => {
    expect(target?.services).toContainEqual({
      binding: "EVENT_INGEST",
      service: expect.any(String),
      entrypoint: "EvaluationEntrypoint",
    });
  });
});

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
