import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireHostedWranglerEnvTarget } from "./lib/hosted-bindings.mjs";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

export const PRIVACY_EXPORT_ABORT_RULE_ID = "privacy-exports-abort-incomplete-within-one-day";
const ONE_DAY_SECONDS = 24 * 60 * 60;

export async function ensurePrivacyExportLifecycle({
  accountId,
  apiToken,
  bucketName,
  fetchImpl = fetch,
}) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/lifecycle`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const currentRules = await readRules(fetchImpl, url, headers);
  const desiredRule = {
    id: PRIVACY_EXPORT_ABORT_RULE_ID,
    enabled: true,
    conditions: { prefix: "" },
    abortMultipartUploadsTransition: {
      condition: { maxAge: ONE_DAY_SECONDS, type: "Age" },
    },
  };

  if (currentRules.some(isDesiredRule)) return { changed: false };

  const rules = [
    ...currentRules.filter((rule) => rule?.id !== PRIVACY_EXPORT_ABORT_RULE_ID),
    desiredRule,
  ];
  await cloudflareRequest(fetchImpl, url, headers, {
    method: "PUT",
    body: JSON.stringify({ rules }),
  });

  const persistedRules = await readRules(fetchImpl, url, headers);
  if (!persistedRules.some(isDesiredRule)) {
    throw new Error(`Cloudflare did not persist lifecycle rule ${PRIVACY_EXPORT_ABORT_RULE_ID}`);
  }
  return { changed: true };
}

function isDesiredRule(rule) {
  const condition = rule?.abortMultipartUploadsTransition?.condition;
  return (
    rule?.id === PRIVACY_EXPORT_ABORT_RULE_ID &&
    rule.enabled === true &&
    rule?.conditions?.prefix === "" &&
    condition?.type === "Age" &&
    condition.maxAge === ONE_DAY_SECONDS
  );
}

async function readRules(fetchImpl, url, headers) {
  const payload = await cloudflareRequest(fetchImpl, url, headers);
  if (!Array.isArray(payload?.result?.rules)) {
    throw new Error("Cloudflare lifecycle response did not contain a rules array");
  }
  return payload.result.rules;
}

async function cloudflareRequest(fetchImpl, url, headers, init = {}) {
  const response = await fetchImpl(url, { ...init, headers });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare lifecycle API returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || payload?.success !== true) {
    const messages = Array.isArray(payload?.errors)
      ? payload.errors
          .map((error) => error?.message)
          .filter(Boolean)
          .join("; ")
      : "";
    throw new Error(
      `Cloudflare lifecycle API failed with HTTP ${response.status}${messages ? `: ${messages}` : ""}`,
    );
  }
  return payload;
}

async function main() {
  const environment = process.argv[2];
  if (environment !== "production" && environment !== "shared-preview") {
    throw new Error(
      "usage: node scripts/ensure-privacy-export-lifecycle.mjs <production|shared-preview>",
    );
  }

  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
  const configPath = join(process.cwd(), "wrangler.jsonc");
  const config = parseWranglerConfigFile(configPath);
  const target = requireHostedWranglerEnvTarget(config, environment, configPath);
  const bucket = target.r2_buckets?.find((candidate) => candidate.binding === "PRIVACY_EXPORTS");
  if (typeof bucket?.bucket_name !== "string" || bucket.bucket_name.length === 0) {
    throw new Error(`${configPath} env.${environment} must bind PRIVACY_EXPORTS to an R2 bucket`);
  }

  const result = await ensurePrivacyExportLifecycle({
    accountId,
    apiToken,
    bucketName: bucket.bucket_name,
  });
  console.log(
    `${bucket.bucket_name}: verified one-day abort policy for incomplete privacy export uploads${result.changed ? " (updated)" : ""}`,
  );
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(
      `ensure-privacy-export-lifecycle: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
