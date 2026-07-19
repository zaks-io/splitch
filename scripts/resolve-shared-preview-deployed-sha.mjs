#!/usr/bin/env node
import { resolveDeployedCommitSha } from "./lib/shared-preview-deployment-evidence.mjs";

const route = {
  surface: "Auth API",
  service: "splitch-auth-api",
  url: process.env.SPLITCH_SHARED_PREVIEW_HEALTH_URL ?? "https://auth.preview.splitch.dev/health",
};

try {
  const response = await fetch(route.url);
  if (!response.ok) {
    throw new Error(`${route.surface} health returned HTTP ${response.status}`);
  }
  const deployedCommitSha = resolveDeployedCommitSha({
    body: await response.json(),
    expectedPlatformTarget: "shared-preview",
    route,
  });
  process.stdout.write(`${deployedCommitSha}\n`);
} catch (error) {
  console.error(
    `shared-preview-deployed-sha: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
