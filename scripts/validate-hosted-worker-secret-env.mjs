import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateHostedWorkerSecretEnv } from "./lib/hosted-worker-secrets.mjs";

const envName = process.argv[2];
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

try {
  const names = validateHostedWorkerSecretEnv(repoRoot, envName, process.env);
  console.log(
    `validate-hosted-worker-secret-env: ${envName} has ${names.length} required Worker secret values`,
  );
} catch (error) {
  console.error(
    `validate-hosted-worker-secret-env: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
