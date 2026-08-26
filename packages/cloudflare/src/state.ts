import { DurableObject } from "cloudflare:workers";
import {
  type CloudflareConfigSnapshot,
  EvaluationContextSchema,
  ResolutionDetailsSchema,
  VariantValueSchema,
} from "@splitch/contracts";
import { type EvaluateResult, evaluatePath, parseConfigSnapshot } from "@splitch/evaluation-core";
import { canonicalJson } from "./canonical-json";
import { hmacHex, randomSecret, sha256Hex } from "./crypto";
import { deliverExposure, exceededPrivacyDeadline } from "./exposure-delivery";
import type {
  CloudflareEvaluationContext,
  CloudflareResolutionDetails,
  CloudflareRuntimeStatus,
} from "./public-types";
import { detailsFor, failureDetails } from "./resolution";
import { STATE_SCHEMA } from "./state-schema";
import { StateStorage } from "./state-storage";

export class SplitchState extends DurableObject<Env> {
  private readonly state = new StateStorage(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state.initialize(STATE_SCHEMA);
    });
  }

  async applySnapshot(
    payload: string,
    deliveryId: string,
  ): Promise<{ ok: true; environmentVersion: number } | { ok: false; reason: "scope_mismatch" }> {
    const snapshot = parseConfigSnapshot(payload, "Cloudflare");
    const now = new Date().toISOString();
    const result:
      | { ok: true; environmentVersion: number }
      | { ok: false; reason: "scope_mismatch" } = this.ctx.storage.transactionSync(() => {
      const existing = this.state.integration();
      if (existing) {
        if (existing.appId !== snapshot.appId || existing.environmentId !== snapshot.environmentId)
          return { ok: false, reason: "scope_mismatch" };
        if (snapshot.environmentVersion <= existing.snapshotVersion) {
          this.state.recordPushClaim(deliveryId, snapshot.environmentVersion, now);
          return { ok: true, environmentVersion: existing.snapshotVersion };
        }
      }
      const identityKey = existing?.identityKey ?? randomSecret();
      this.ctx.storage.sql.exec(
        `INSERT INTO integration (
          singleton, installation_id, app_id, environment_id, identity_key, snapshot_version, applied_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          snapshot_version = excluded.snapshot_version, applied_at = excluded.applied_at`,
        this.env.SPLITCH_INSTALLATION_ID,
        snapshot.appId,
        snapshot.environmentId,
        identityKey,
        snapshot.environmentVersion,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO snapshot (singleton, payload) VALUES (1, ?)
         ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload`,
        payload,
      );
      this.state.recordPushClaim(deliveryId, snapshot.environmentVersion, now);
      return { ok: true, environmentVersion: snapshot.environmentVersion };
    });
    this.state.invalidateConfiguration();
    await this.state.ensureAlarm();
    return result;
  }

  async evaluateDetails(
    flagKey: string,
    rawContext: CloudflareEvaluationContext,
  ): Promise<CloudflareResolutionDetails> {
    const defaultValue = VariantValueSchema.parse(rawContext.defaultValue ?? false);
    if (!rawContext.idempotencyKey)
      return failureDetails(
        defaultValue,
        "ERROR",
        "INTERNAL_SERVER_ERROR",
        "idempotencyKey is required for Cloudflare evaluation",
      );
    const context = EvaluationContextSchema.parse({
      targetingKey: rawContext.targetingKey,
      idType: rawContext.idType ?? "user",
      attributes: rawContext.attributes ?? {},
    });
    const integration = this.state.integration();
    const configuration = integration
      ? this.state.configuration(integration.snapshotVersion)
      : null;
    if (!integration || !configuration)
      return failureDetails(
        defaultValue,
        "ERROR",
        "PROVIDER_NOT_READY",
        "@splitch/cloudflare has no applied configuration snapshot",
      );
    const { snapshot, provider } = configuration;
    const fingerprint = await sha256Hex(canonicalJson({ flagKey, context, defaultValue }));
    const prior = this.state.claim(rawContext.idempotencyKey);
    if (prior) {
      const replayed = this.replayClaim(prior, fingerprint, rawContext.idempotencyKey);
      await this.state.ensureAlarm();
      return replayed;
    }
    const targetingKeyHash = await hmacHex(
      integration.identityKey,
      `${context.idType}:${context.targetingKey}`,
    );
    const assignments = this.state.assignments(context.idType, targetingKeyHash);
    const result = await evaluatePath(
      {
        appId: snapshot.appId,
        environmentId: snapshot.environmentId,
        flagKey,
        evaluationContext: context,
      },
      {
        provider,
        assignmentStore: readOnlyAssignmentStore(assignments),
        logger: console,
      },
    );
    const details = detailsFor(snapshot, flagKey, result, defaultValue);
    const exposureId = stableUuid(
      await sha256Hex(`${integration.installationId}:${rawContext.idempotencyKey}`),
    );
    const committed = this.commitEvaluation({
      idempotencyKey: rawContext.idempotencyKey,
      fingerprint,
      details,
      result,
      snapshot,
      context,
      targetingKeyHash,
      exposureId,
    });
    await this.state.ensureAlarm();
    return committed;
  }

  status(): CloudflareRuntimeStatus {
    const integration = this.state.integration();
    const counts = this.ctx.storage.sql
      .exec<{ state: string; count: number }>(
        "SELECT state, COUNT(*) AS count FROM exposure_outbox GROUP BY state",
      )
      .toArray();
    const count = (state: string) => counts.find((row) => row.state === state)?.count ?? 0;
    return {
      installationId: this.env.SPLITCH_INSTALLATION_ID,
      state: integration ? "active" : "not_ready",
      appId: integration?.appId ?? null,
      environmentId: integration?.environmentId ?? null,
      appliedEnvironmentVersion: integration?.snapshotVersion ?? null,
      pendingExposureCount: count("pending"),
      terminalExposureCount: count("terminal"),
    };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.state.pruneExpired(now);
    const due = this.state.dueExposures(now);
    for (const row of due) {
      const outcome = exceededPrivacyDeadline(row, now)
        ? "terminal"
        : await deliverExposure(row, this.env.SPLITCH_ENDPOINT, this.env.SPLITCH_API_KEY);
      this.state.finishExposure(row, outcome, now);
    }
    this.state.pruneExpired(now);
    await this.state.ensureAlarm(now);
  }

  private commitEvaluation(input: CommitEvaluationInput): CloudflareResolutionDetails {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.state.claim(input.idempotencyKey);
      if (existing) return this.replayClaim(existing, input.fingerprint, input.idempotencyKey);
      if (input.result.exposure) this.writeExposure(input);
      this.ctx.storage.sql.exec(
        "INSERT INTO evaluation_claims (idempotency_key, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?)",
        input.idempotencyKey,
        input.fingerprint,
        JSON.stringify(input.details),
        new Date().toISOString(),
      );
      return input.details;
    });
  }

  private writeExposure(input: CommitEvaluationInput): void {
    const exposure = input.result.exposure;
    if (!exposure) return;
    const run = input.snapshot.runs.find((candidate) => candidate.id === exposure.liveRunId);
    if (!run) throw new Error(`Live Run "${exposure.liveRunId}" is absent from the snapshot`);
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO assignments
       (experiment_id, id_type, targeting_key_hash, run_id, variant) VALUES (?, ?, ?, ?, ?)`,
      exposure.experimentId,
      input.context.idType,
      input.targetingKeyHash,
      exposure.liveRunId,
      exposure.variant,
    );
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO exposure_outbox (
        exposure_id, installation_id, flag_key, experiment_id, run_id, run_config_hash,
        context_json, variant_name, exposed_at, state, attempt_count, next_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      input.exposureId,
      this.env.SPLITCH_INSTALLATION_ID,
      exposure.flagKey,
      exposure.experimentId,
      exposure.liveRunId,
      run.configHash,
      JSON.stringify(input.context),
      exposure.variant,
      new Date(now).toISOString(),
      now,
      now,
    );
  }

  private replayClaim(
    claim: { fingerprint: string; resultJson: string },
    fingerprint: string,
    idempotencyKey: string,
  ): CloudflareResolutionDetails {
    if (claim.fingerprint !== fingerprint)
      throw new Error(
        `IDEMPOTENCY_KEY_CONFLICT: ${idempotencyKey} was reused for a different evaluation`,
      );
    return ResolutionDetailsSchema.parse(JSON.parse(claim.resultJson));
  }
}

interface CommitEvaluationInput {
  idempotencyKey: string;
  fingerprint: string;
  details: CloudflareResolutionDetails;
  result: EvaluateResult;
  snapshot: CloudflareConfigSnapshot;
  context: { targetingKey: string; idType: string; attributes: Record<string, unknown> };
  targetingKeyHash: string;
  exposureId: string;
}

function readOnlyAssignmentStore(assignments: Map<string, { runId: string; variant: string }>) {
  const noWrite = async () => {
    throw new Error("read-only local Assignment Store");
  };
  return {
    async getAll() {
      return assignments;
    },
    put: noWrite,
    putHashed: noWrite,
  };
}

function stableUuid(hex: string): string {
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return value;
}
