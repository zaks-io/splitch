import { appendFileSync } from "node:fs";

const required = ["TURBO_TOKEN", "TURBO_TEAM", "TURBO_REMOTE_CACHE_SIGNATURE_KEY"];
const missing = required.filter((name) => !process.env[name]);
const signatureKey = process.env.TURBO_REMOTE_CACHE_SIGNATURE_KEY ?? "";
const weakSignature = signatureKey.length > 0 && Buffer.byteLength(signatureKey) < 32;
const failOnUnavailable = process.argv.includes("--required");

function appendSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  appendFileSync(summaryPath, `${message}\n`);
}

if (missing.length > 0 || weakSignature) {
  const reason =
    missing.length > 0
      ? `missing ${missing.join(", ")}`
      : "TURBO_REMOTE_CACHE_SIGNATURE_KEY must be at least 32 bytes";
  const message = `Turbo remote cache unavailable: ${reason}. Values were not printed.`;
  const level = failOnUnavailable ? "error" : "warning";
  console.log(`::${level} title=Turbo remote cache unavailable::${message}`);
  appendSummary(`- ${message}`);
  process.exit(failOnUnavailable ? 1 : 0);
}

const message = "Turbo remote cache inputs are present. Values were not printed.";
console.log(message);
appendSummary(`- ${message}`);
