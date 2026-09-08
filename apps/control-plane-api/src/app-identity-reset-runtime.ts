import { appScope, createRepository } from "@splitch/db";
import {
  APP_IDENTITY_RESET_SUBJECT_REF,
  type AppIdentityResetPurgers,
  type AppIdentityResetReleasers,
} from "@splitch/privacy";
import { revokeEnvironmentCredentialsForAppDelete } from "./app-environment-credentials";
import { durableCredentialCacheWriterAccess } from "./credential-cache-writer-do";
import type { ControlPlaneApiEnv } from "./env";
import { deleteAppPrivacyExports } from "./privacy-export-cleanup";

export function productionAppIdentityResetPurgers(
  env: ControlPlaneApiEnv,
  resetId: string,
): AppIdentityResetPurgers {
  const repo = createRepository(env.DB);
  let environments: readonly { id: string }[] | undefined;
  const environmentRows = async () =>
    (environments ??= await repo.identity.listEnvironments(appScope(resetAppId)));
  let resetAppId = "";
  const scoped =
    <T>(run: (appId: string) => Promise<T>) =>
    async ({ appId }: { appId: string }) => {
      if (resetAppId && resetAppId !== appId)
        throw new Error("App identity purgers changed App scope");
      resetAppId = appId;
      return run(appId);
    };
  return {
    runs_and_credentials: scoped(async (appId) => {
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE runs SET status = 'ended', ended_at = ?, end_reason = 'identity_reset' WHERE app_id = ? AND status = 'running'",
        ).bind(now, appId),
        env.DB.prepare(
          "UPDATE experiments SET live_run_id = NULL, updated_at = ? WHERE app_id = ? AND live_run_id IS NOT NULL",
        ).bind(now, appId),
      ]);
      const rows = await environmentRows();
      for (const environment of rows) {
        await revokeEnvironmentCredentialsForAppDelete(
          {
            repo,
            credentialStore: env.CREDENTIAL_STORE,
            credentialCacheWriter: durableCredentialCacheWriterAccess(env.CREDENTIAL_CACHE_WRITER),
          },
          appId,
          environment.id,
        );
      }
      return `d1-runs-and-credentials:environments=${rows.length}`;
    }),
    delivery: async ({ appId, currentVersion }) => {
      if (resetAppId && resetAppId !== appId)
        throw new Error("App identity purgers changed App scope");
      resetAppId = appId;
      const configKeys =
        (await deleteKvPrefix(env.CONFIG_STORE, `app:${appId}:`)) +
        (await deleteKvPrefix(env.CONFIG_STORE, `live_run:${appId}:`));
      const proof = await env.EVENT_INGEST_API.purgeAppIdentityDelivery(
        appId,
        resetId,
        currentVersion,
      );
      return `delivery:config_keys=${configKeys};${proof}`;
    },
    assignments: async ({ appId, destroyedVersions }) => {
      if (resetAppId && resetAppId !== appId)
        throw new Error("App identity purgers changed App scope");
      resetAppId = appId;
      return env.EVALUATION_API.purgeAppIdentityAssignments(appId, resetId, destroyedVersions);
    },
    analytics: async ({ appId, destroyedVersions }) => {
      if (resetAppId && resetAppId !== appId)
        throw new Error("App identity purgers changed App scope");
      resetAppId = appId;
      return env.ANALYSIS_API.purgeAppIdentityAnalytics(appId, destroyedVersions, resetId);
    },
    retry_claims: scoped(async (appId) => {
      const rows = await environmentRows();
      return env.EVALUATION_API.purgeAppIdentityRetryClaims(
        appId,
        rows.map((row) => row.id),
      );
    }),
    entity_deletions: scoped(async (appId) => {
      const result = await env.DB.prepare("DELETE FROM entity_deletions WHERE app_id = ?")
        .bind(appId)
        .run();
      return `d1-entity-deletions:${String(result.meta.changes ?? 0)}`;
    }),
    privacy_subject_refs: scoped(async (appId) => {
      const redactedAt = new Date().toISOString();
      const [jobs, requests] = await env.DB.batch([
        env.DB.prepare(
          `UPDATE privacy_jobs SET status = 'completed', lease_expires_at = NULL,
             claim_token = NULL, artifact_key = NULL, artifact_sha256 = NULL,
             artifact_expires_at = NULL, entity_family_hash = NULL,
             error_code = 'APP_IDENTITY_RESET', updated_at = ?
           WHERE request_id IN (SELECT request_id FROM privacy_requests WHERE app_id = ?)`,
        ).bind(redactedAt, appId),
        env.DB.prepare(
          `UPDATE privacy_requests SET subject_ref = ?, subject_ref_redacted_at = ?,
             result_json = NULL, status = 'completed', completed_at = ?
           WHERE app_id = ? AND subject_type = 'entity'
             AND (subject_ref != ? OR result_json IS NOT NULL OR status != 'completed')`,
        ).bind(
          APP_IDENTITY_RESET_SUBJECT_REF,
          redactedAt,
          redactedAt,
          appId,
          APP_IDENTITY_RESET_SUBJECT_REF,
        ),
      ]);
      const artifacts = await deleteAppPrivacyExports(env.PRIVACY_EXPORTS, appId);
      return `d1-privacy-subject-refs:${String(requests?.meta.changes ?? 0)};jobs=${String(jobs?.meta.changes ?? 0)};artifacts=${String(artifacts)}`;
    }),
  };
}

export function productionAppIdentityResetReleasers(
  env: ControlPlaneApiEnv,
  appId: string,
  resetId: string,
): AppIdentityResetReleasers {
  return {
    evaluation: async (record) => {
      await env.EVALUATION_API.completeAppIdentityReset(appId, resetId, record.currentVersion);
      return `evaluation-release:${record.currentVersion}`;
    },
    event_ingest: async (record) => {
      await env.EVENT_INGEST_API.completeAppIdentityReset(appId, resetId, record.currentVersion);
      return `event-ingest-release:${record.currentVersion}`;
    },
  };
}

async function deleteKvPrefix(kv: KVNamespace, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
      await kv.delete(key.name);
      deleted += 1;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return deleted;
}
