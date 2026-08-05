import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt, userRef } from "./columns";
import { apps, environments } from "./identity";
import { flags } from "./flags";

/**
 * Experiment-domain D1 tables: Experiments (with the draft_* next-Run staging
 * area), Runs (the frozen assignment-config snapshot), and Metrics.
 * Source of truth: docs/spec/contracts/storage-schemas-d1-experiment.md.
 *
 * Co-scoping (ADR-0018 / ADR-0027): experiments and runs carry both `app_id` and
 * `environment_id`. metrics is App-level (`app_id` only).
 *
 * The `runs` table is the SINGLE authoring point for the storage-only
 * decision/stats columns the S02 Run Zod leaf deliberately OMITS (run_number,
 * targeting_key_field, decision_family, horizon, target_n, sample_size_locked,
 * guardrail_decisions, start_reason, end_reason, confidence_level). Those columns
 * live ONLY here, never on the wire leaf.
 *
 * SEAM-ENFORCED REFERENCES (not DB FKs): activation_metric_id, default_variant_id,
 * and live_run_id are plain text. Their referential integrity is enforced in the
 * data-access seam (ADR-0018), NOT by a SQLite foreign key — these are cyclic
 * (experiments ↔ runs via live_run_id) or forward (metrics, variants) references
 * that a single SQLite migration cannot FK cleanly. SPL-11 must not assume DB-level
 * enforcement for them.
 */

export const experiments = sqliteTable(
  "experiments",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    // Co-scoped with app_id (ADR-0027).
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    key: text("key").notNull(),
    flagId: text("flag_id")
      .notNull()
      .references(() => flags.id),
    name: text("name").notNull(),
    description: text("description"),
    hypothesis: text("hypothesis"),
    owner: text("owner"),
    tags: text("tags").notNull().default("[]"),
    status: text("status").notNull().default("draft"),
    // EC field name read as the Targeting Key (e.g. "userId").
    targetingKeyField: text("targeting_key_field").notNull(),
    // Entity type label the key identifies (e.g. "user"); stamped as id_type.
    targetingKeyType: text("targeting_key_type").notNull(),
    confidenceLevel: real("confidence_level").notNull().default(0.95),
    defaultVariantId: text("default_variant_id"),
    // JSON arrays of MetricRef.
    metrics: text("metrics").notNull(),
    guardrailMetrics: text("guardrail_metrics").notNull(),
    activationMetricId: text("activation_metric_id"),
    conversionWindowMs: integer("conversion_window_ms").notNull().default(0),
    // JSON string array.
    dimensions: text("dimensions").notNull(),
    // draft_* = staging area for the next Run. Nullable: a fresh Experiment has
    // no staged Run yet. Start is the single reset point (run-state-machine).
    draftAllocation: text("draft_allocation"),
    draftSalt: text("draft_salt"),
    draftTargetingRules: text("draft_targeting_rules"),
    draftSegmentIds: text("draft_segment_ids"),
    liveRunId: text("live_run_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    createdBy: userRef("created_by"),
    updatedBy: userRef("updated_by"),
  },
  (t) => [uniqueIndex("experiments_app_env_key_unique").on(t.appId, t.environmentId, t.key)],
);

/**
 * Run = the frozen assignment-config snapshot taken at Start. The `// immutable`
 * columns are write-once at Start; the data-access seam must never expose an
 * UPDATE path for them (assignment-config immutability, ADR-0002/ADR-0003).
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    // Co-scoped with app_id (ADR-0027).
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    experimentId: text("experiment_id")
      .notNull()
      .references(() => experiments.id),
    // 1-based ordinal within the Experiment ("Run N" label). immutable.
    runNumber: integer("run_number").notNull(),
    status: text("status").notNull().default("running"),
    // EC field name frozen from the Experiment at Start. immutable.
    targetingKeyField: text("targeting_key_field").notNull(),
    // Entity type label frozen at Start (the Run's id_type). immutable.
    targetingKeyType: text("targeting_key_type").notNull(),
    activationMetricId: text("activation_metric_id"), // immutable
    salt: text("salt").notNull(), // immutable
    // JSON { [variantName]: number }, keyed by Variant name. immutable.
    allocation: text("allocation").notNull(),
    variantSet: text("variant_set").notNull(), // JSON. immutable
    // Control Variant identity frozen from the Experiment at Start. immutable.
    controlVariantId: text("control_variant_id").notNull(),
    // JSON TargetingRule[] resolved snapshot frozen at Start ([] = all eligible).
    targetingRules: text("targeting_rules").notNull(), // immutable
    confidenceLevel: real("confidence_level").notNull(), // locked at Start
    horizon: text("horizon").notNull().default("sequential"), // locked at Start
    targetN: integer("target_n"), // sequential tuning
    sampleSizeLocked: integer("sample_size_locked"), // required for fixed horizon
    // JSON: locked goal Metric × Variant × Primary Dimension members.
    decisionFamily: text("decision_family").notNull(), // locked at Start
    // JSON: locked thresholds/directions.
    guardrailDecisions: text("guardrail_decisions").notNull(), // locked at Start
    // JSON MetricVarianceConfig[]: the winsorization and CUPED-coverage rule per
    // Metric, resolved from the Metric rows at Start so a re-analysis reproduces
    // the original numbers even after the Metric is edited.
    metricVarianceConfig: text("metric_variance_config").notNull().default("[]"), // locked at Start
    configHash: text("config_hash").notNull(), // computed SHA-256. immutable
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    startReason: text("start_reason"), // immutable
    endReason: text("end_reason"),
    createdAt: createdAt(),
    createdBy: userRef("created_by"),
  },
  (t) => [
    // salt unique per Experiment; run numbers dense + unique per Experiment.
    uniqueIndex("runs_experiment_salt_unique").on(t.experimentId, t.salt),
    uniqueIndex("runs_experiment_run_number_unique").on(t.experimentId, t.runNumber),
  ],
);

export const metrics = sqliteTable(
  "metrics",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull(),
    eventName: text("event_name").notNull(),
    eventValueField: text("event_value_field"),
    denominatorMetricId: text("denominator_metric_id"),
    // Guardrail bound and variance-reduction knobs. Null means "engine default";
    // Run Start resolves and freezes them onto the Run.
    downsideThresholdPct: real("downside_threshold_pct"),
    winsorize: integer("winsorize", { mode: "boolean" }),
    winsorizePct: real("winsorize_pct"),
    cupedCoverageThresholdPct: real("cuped_coverage_threshold_pct"),
    createdAt: createdAt(),
    createdBy: userRef("created_by"),
  },
  (t) => [uniqueIndex("metrics_app_key_unique").on(t.appId, t.key)],
);
