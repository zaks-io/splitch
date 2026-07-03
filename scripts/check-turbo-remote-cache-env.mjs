import { appendFileSync } from "node:fs";

const required = ["TURBO_TOKEN", "TURBO_TEAM", "TURBO_REMOTE_CACHE_SIGNATURE_KEY"];
const missing = required.filter((name) => !process.env[name]);

function appendSummary(message) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }

  appendFileSync(summaryPath, `${message}\n`);
}

if (missing.length > 0) {
  const message = `Turbo remote cache unavailable: missing ${missing.join(", ")}. Values were not printed.`;
  console.log(`::warning title=Turbo remote cache unavailable::${message}`);
  appendSummary(`- ${message}`);
  process.exit(0);
}

const message = "Turbo remote cache inputs are present. Values were not printed.";
console.log(message);
appendSummary(`- ${message}`);
