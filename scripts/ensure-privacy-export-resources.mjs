import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireHostedWranglerEnvTarget } from "./lib/hosted-bindings.mjs";
import { parseWranglerConfigFile } from "./lib/wrangler-config.mjs";

export async function ensurePrivacyExportResources({
  accountId,
  apiToken,
  bucketName,
  queueNames,
  fetchImpl = fetch,
  waitImpl = wait,
}) {
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const accountUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}`;
  const created = [];

  const bucketUrl = `${accountUrl}/r2/buckets/${encodeURIComponent(bucketName)}`;
  const bucket = await cloudflareRequest(fetchImpl, bucketUrl, headers, {}, [404]);
  if (bucket === null) {
    await cloudflareRequest(fetchImpl, `${accountUrl}/r2/buckets`, headers, {
      method: "POST",
      body: JSON.stringify({ name: bucketName }),
    });
    created.push(bucketName);
  }
  await cloudflareRequest(fetchImpl, bucketUrl, headers);

  const queues = await listQueues(fetchImpl, `${accountUrl}/queues`, headers);
  for (const queueName of queueNames) {
    if (queues.has(queueName)) continue;
    await cloudflareRequest(fetchImpl, `${accountUrl}/queues`, headers, {
      method: "POST",
      body: JSON.stringify({ queue_name: queueName }),
    });
    created.push(queueName);
  }

  const missingQueues = await waitForQueues({
    fetchImpl,
    headers,
    queueNames,
    url: `${accountUrl}/queues`,
    waitImpl,
  });
  if (missingQueues.length > 0) {
    throw new Error(`Cloudflare did not persist queues: ${missingQueues.join(", ")}`);
  }

  return { created };
}

async function waitForQueues({ fetchImpl, headers, queueNames, url, waitImpl }) {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const queues = await listQueues(fetchImpl, url, headers);
    const missing = queueNames.filter((queueName) => !queues.has(queueName));
    if (missing.length === 0 || attempt === maxAttempts) return missing;
    await waitImpl(1_000);
  }
  throw new Error("unreachable queue verification state");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function listQueues(fetchImpl, url, headers) {
  const names = new Set();
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await cloudflareRequest(fetchImpl, `${url}?page=${page}`, headers);
    const current = parseQueuesPage(payload);
    for (const name of current.names) names.add(name);
    totalPages = current.totalPages;
    page += 1;
  } while (page <= totalPages);
  return names;
}

function parseQueuesPage(payload) {
  if (!Array.isArray(payload.result)) {
    throw new Error("Cloudflare queues response did not contain a result array");
  }
  const totalPages = payload.result_info?.total_pages ?? 1;
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    throw new Error("Cloudflare queues response contained invalid pagination");
  }
  const names = payload.result
    .map((queue) => queue?.queue_name)
    .filter((name) => typeof name === "string");
  return { names, totalPages };
}

async function cloudflareRequest(fetchImpl, url, headers, init = {}, allowedStatuses = []) {
  const response = await fetchImpl(url, { ...init, headers });
  if (allowedStatuses.includes(response.status)) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare resources API returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || payload?.success !== true) {
    const messages = Array.isArray(payload?.errors)
      ? payload.errors
          .map((error) => error?.message)
          .filter(Boolean)
          .join("; ")
      : "";
    throw new Error(
      `Cloudflare resources API failed with HTTP ${response.status}${messages ? `: ${messages}` : ""}`,
    );
  }
  return payload;
}

function privacyExportResources(target, environment, configPath) {
  const bucket = target.r2_buckets?.find((candidate) => candidate.binding === "PRIVACY_EXPORTS");
  if (typeof bucket?.bucket_name !== "string" || bucket.bucket_name.length === 0) {
    throw new Error(`${configPath} env.${environment} must bind PRIVACY_EXPORTS to an R2 bucket`);
  }

  const producer = target.queues?.producers?.find(
    (candidate) => candidate.binding === "PRIVACY_JOBS_QUEUE",
  );
  const consumer = target.queues?.consumers?.find(
    (candidate) => candidate.queue === producer?.queue,
  );
  const queueNames = [producer?.queue, consumer?.dead_letter_queue];
  if (queueNames.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error(
      `${configPath} env.${environment} must bind PRIVACY_JOBS_QUEUE with a dead-letter queue`,
    );
  }

  return { bucketName: bucket.bucket_name, queueNames };
}

async function main() {
  const environment = process.argv[2];
  if (environment !== "production" && environment !== "shared-preview") {
    throw new Error(
      "usage: node scripts/ensure-privacy-export-resources.mjs <production|shared-preview>",
    );
  }

  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
  const configPath = join(process.cwd(), "wrangler.jsonc");
  const config = parseWranglerConfigFile(configPath);
  const target = requireHostedWranglerEnvTarget(config, environment, configPath);
  const resources = privacyExportResources(target, environment, configPath);
  const result = await ensurePrivacyExportResources({ accountId, apiToken, ...resources });
  console.log(
    `verified privacy export bucket and queues${result.created.length > 0 ? ` (created: ${result.created.join(", ")})` : ""}`,
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
      `ensure-privacy-export-resources: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
