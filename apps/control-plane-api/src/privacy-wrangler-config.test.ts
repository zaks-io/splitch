import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, it } from "vitest";

const config = readWranglerConfig();

describe("Control Plane privacy job bindings", () => {
  it.each([
    ["local", config, "splitch-privacy-jobs-local", "splitch-privacy-exports-local"],
    [
      "shared-preview",
      config.env?.["shared-preview"],
      "splitch-privacy-jobs-shared-preview",
      "splitch-privacy-exports-shared-preview",
    ],
    ["production", config.env?.production, "splitch-privacy-jobs", "splitch-privacy-exports"],
  ])(
    "binds one durable privacy queue and private export bucket for %s",
    (_name, target, queue, bucket) => {
      expect(target?.queues?.producers).toContainEqual({ binding: "PRIVACY_JOBS_QUEUE", queue });
      expect(target?.queues?.consumers).toContainEqual({
        queue,
        max_batch_size: 1,
        max_retries: 7,
        dead_letter_queue: queue.replace("jobs", "jobs-dlq"),
      });
      expect(target?.r2_buckets).toEqual([{ binding: "PRIVACY_EXPORTS", bucket_name: bucket }]);
    },
  );

  it.each([
    ["shared-preview", config.env?.["shared-preview"]],
    ["production", config.env?.production],
  ])("requires the hosted URL signing secret for %s", (_name, target) => {
    expect(target?.secrets?.required).toContain("PRIVACY_EXPORT_URL_SECRET");
    expect(target?.vars?.PRIVACY_EXPORT_URL_SECRET).toBeUndefined();
  });
});

interface Target {
  env?: Record<string, Target | undefined>;
  queues?: {
    producers?: Array<{ binding?: string; queue?: string }>;
    consumers?: Array<{
      queue?: string;
      max_batch_size?: number;
      max_retries?: number;
      dead_letter_queue?: string;
    }>;
  };
  r2_buckets?: Array<{ binding?: string; bucket_name?: string }>;
  secrets?: { required?: string[] };
  vars?: Record<string, unknown>;
}

function readWranglerConfig(): Target {
  const path = new URL("../wrangler.jsonc", import.meta.url);
  const parsed = parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error(parsed.error.messageText.toString());
  return parsed.config as Target;
}
