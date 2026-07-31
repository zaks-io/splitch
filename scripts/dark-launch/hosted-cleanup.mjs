import { PROPAGATION_WINDOW_MS } from "./constants.mjs";
import { listApps } from "./control-plane.mjs";
import { runExternalResolve } from "./pack-consumer.mjs";

export const RESULT_REREAD_DELAY_MS = 2_000;

export async function cleanupDeferredRuns(runResults) {
  const cleanupResults = [];
  const failures = [];
  for (const run of [...runResults].reverse()) {
    try {
      if (typeof run.cleanup !== "function") {
        throw new Error(`hosted run ${run.runId} did not return deferred cleanup`);
      }
      cleanupResults.push({ runId: run.runId, ...(await run.cleanup()) });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more hosted onboarding cleanups failed");
  }
  return cleanupResults;
}

export async function findOrphanedDarkLaunchApps(
  config,
  mcpClient,
  rereadDelayMs = RESULT_REREAD_DELAY_MS,
) {
  const first = await readOrphanedDarkLaunchApps(config, mcpClient);
  await delay(rereadDelayMs);
  const final = await readOrphanedDarkLaunchApps(config, mcpClient);
  const orphaned = [...first, ...final];
  if (orphaned.length > 0) {
    throw new Error(`cleanup assertion found orphaned Apps: ${JSON.stringify(orphaned)}`);
  }
  return [first, final];
}

export async function assertRevokedCredential(consumer, evaluationBaseUrl, clientKey, flagKey) {
  const deadline = Date.now() + PROPAGATION_WINDOW_MS;
  let last;
  while (Date.now() <= deadline) {
    last = await runExternalResolve(consumer, "verify", {
      clientKey,
      endpoint: evaluationBaseUrl,
      flagKey,
      targetingKey: "deleted-app-credential-proof",
      attributes: {},
    });
    if (last.reason === "ERROR" && last.errorCode === "CREDENTIAL_REVOKED") return last;
    await delay(250);
  }
  throw new Error(
    `deleted transient App credential expected CREDENTIAL_REVOKED, got ${JSON.stringify(last)}`,
  );
}

async function readOrphanedDarkLaunchApps(config, mcpClient) {
  const apps = await listApps({ callTool: mcpClient.callTool }, config.smokeOrgId);
  const items = Array.isArray(apps) ? apps : (apps.items ?? apps.apps ?? []);
  return items
    .filter((app) => typeof app.key === "string" && app.key.startsWith("dark-launch-app-"))
    .map((app) => ({ id: app.id, key: app.key }));
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
