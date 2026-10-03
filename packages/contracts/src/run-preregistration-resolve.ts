import {
  type PreRegistration,
  type PreRegistrationIntent,
  type PreRegistrationIssueCode,
  type PreRegistrationMetric,
  PreRegistrationIntentSchema,
  PreRegistrationSchema,
} from "./run-preregistration";

/**
 * Resolve caller pre-registration intent into the frozen form, against the
 * Metric ids the Run will lock. Both Start doors call this so an Approval
 * proposal freezes the same object the reviewer saw.
 */

export interface PreRegistrationIssue {
  path: string[];
  message: string;
  code: PreRegistrationIssueCode;
}

export function resolvePreRegistration(
  raw: unknown,
  runMetricIds: ReadonlySet<string>,
  options: {
    horizon?: "sequential" | "fixed";
    /** Decision-family Metric ids the Run will lock (non-Guardrail goals). */
    lockedGoalMetricIds?: ReadonlySet<string>;
  } = {},
): { ok: true; value: PreRegistration } | { ok: false; issues: PreRegistrationIssue[] } {
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      issues: [
        {
          path: ["body", "preRegistration"],
          message: "preRegistration was present but empty",
          code: "PREREG_MALFORMED",
        },
      ],
    };
  }
  const parsed = PreRegistrationIntentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: ["body", "preRegistration", ...issue.path.map(String)],
        message: issue.message,
        code: "PREREG_MALFORMED" as const,
      })),
    };
  }
  return validateAndFreeze(parsed.data, runMetricIds, options.horizon, options.lockedGoalMetricIds);
}

function validateAndFreeze(
  intent: PreRegistrationIntent,
  runMetricIds: ReadonlySet<string>,
  horizon: "sequential" | "fixed" | undefined,
  lockedGoalMetricIds: ReadonlySet<string> | undefined,
): { ok: true; value: PreRegistration } | { ok: false; issues: PreRegistrationIssue[] } {
  const issues = [
    ...hypothesisIssues(intent),
    ...shipRuleIssues(intent, horizon),
    ...primaryMetricIssues(intent, runMetricIds),
    ...metricEntryIssues(intent, runMetricIds),
    ...lockedGoalDesirabilityIssues(intent, lockedGoalMetricIds),
    ...futilityIssues(intent),
  ];
  if (issues.length > 0) return { ok: false, issues };

  const frozen = PreRegistrationSchema.parse({
    hypothesis: intent.hypothesis,
    primary_metric_id: intent.primaryMetricId,
    metrics: intent.metrics.map(freezeMetric),
    ship_rule: {
      required_margin: intent.shipRule.requiredMargin,
      margin_scale: intent.shipRule.marginScale,
      conflict_resolution: intent.shipRule.conflictResolution,
    },
    futility: intent.futility ?? "off",
  });
  return { ok: true, value: frozen };
}

function hypothesisIssues(intent: PreRegistrationIntent): PreRegistrationIssue[] {
  if (intent.hypothesis.trim() !== "") return [];
  return [
    {
      path: ["body", "preRegistration", "hypothesis"],
      message: "hypothesis must be non-empty text",
      code: "PREREG_HYPOTHESIS_REQUIRED",
    },
  ];
}

function shipRuleIssues(
  intent: PreRegistrationIntent,
  horizon: "sequential" | "fixed" | undefined,
): PreRegistrationIssue[] {
  const issues: PreRegistrationIssue[] = [];
  if (!(intent.shipRule.requiredMargin > 0)) {
    issues.push({
      path: ["body", "preRegistration", "shipRule", "requiredMargin"],
      message: "shipRule.requiredMargin must be a positive finite number",
      code: "PREREG_SHIP_RULE_INVALID",
    });
  }
  if (horizon === "sequential" && intent.shipRule.marginScale === "relative") {
    issues.push({
      path: ["body", "preRegistration", "shipRule", "marginScale"],
      message:
        "relative ship-rule margin is not accepted on a sequential Run; sequential Fieller coverage is unproven, so use marginScale absolute or set horizon to fixed",
      code: "PREREG_SHIP_RULE_RELATIVE_SEQUENTIAL_UNSUPPORTED",
    });
  }
  return issues;
}

function primaryMetricIssues(
  intent: PreRegistrationIntent,
  runMetricIds: ReadonlySet<string>,
): PreRegistrationIssue[] {
  const issues: PreRegistrationIssue[] = [];
  if (!runMetricIds.has(intent.primaryMetricId)) {
    issues.push({
      path: ["body", "preRegistration", "primaryMetricId"],
      message: `primaryMetricId ${JSON.stringify(intent.primaryMetricId)} is not one of the Run's Metrics`,
      code: "PREREG_UNKNOWN_PRIMARY_METRIC",
    });
  }
  const listed = intent.metrics.some((metric) => metric.metricId === intent.primaryMetricId);
  if (!listed && runMetricIds.has(intent.primaryMetricId)) {
    issues.push({
      path: ["body", "preRegistration", "metrics"],
      message: "primaryMetricId must appear in metrics",
      code: "PREREG_PRIMARY_METRIC_MISSING",
    });
  }
  return issues;
}

function metricEntryIssues(
  intent: PreRegistrationIntent,
  runMetricIds: ReadonlySet<string>,
): PreRegistrationIssue[] {
  const issues: PreRegistrationIssue[] = [];
  const seen = new Set<string>();
  for (const [index, metric] of intent.metrics.entries()) {
    const base = ["body", "preRegistration", "metrics", String(index)];
    if (seen.has(metric.metricId)) {
      issues.push({
        path: [...base, "metricId"],
        message: `metricId ${JSON.stringify(metric.metricId)} is listed more than once`,
        code: "PREREG_DUPLICATE_METRIC",
      });
      continue;
    }
    seen.add(metric.metricId);
    issues.push(...singleMetricIssues(metric, intent.primaryMetricId, runMetricIds, base));
  }
  return issues;
}

function singleMetricIssues(
  metric: PreRegistrationIntent["metrics"][number],
  primaryMetricId: string,
  runMetricIds: ReadonlySet<string>,
  base: string[],
): PreRegistrationIssue[] {
  const issues: PreRegistrationIssue[] = [];
  if (!runMetricIds.has(metric.metricId)) {
    issues.push({
      path: [...base, "metricId"],
      message: `metricId ${JSON.stringify(metric.metricId)} is not one of the Run's Metrics`,
      code: "PREREG_UNKNOWN_METRIC",
    });
  }
  const hasMde = metric.mdeAbsolute !== undefined || metric.mdeRelative !== undefined;
  if (metric.desirability === undefined) {
    issues.push({
      path: [...base, "desirability"],
      message: desirabilityMessage(
        hasMde,
        metric.metricId === primaryMetricId,
        metric.rope !== undefined,
      ),
      code: "PREREG_DESIRABILITY_REQUIRED",
    });
  }
  if (metric.rope !== undefined && metric.rope.lower >= metric.rope.upper) {
    issues.push({
      path: [...base, "rope"],
      message: `ROPE lower (${metric.rope.lower}) must be strictly less than ROPE upper (${metric.rope.upper})`,
      code: "PREREG_ROPE_BOUNDS_INVALID",
    });
  }
  if (metric.rope?.scale === "relative") {
    issues.push({
      path: [...base, "rope", "scale"],
      message:
        "relative ROPE is not accepted at Start; sequential Fieller coverage is unproven, so ROPE must use scale absolute",
      code: "PREREG_ROPE_RELATIVE_UNSUPPORTED",
    });
  }
  return issues;
}

function desirabilityMessage(hasMde: boolean, isPrimary: boolean, hasRope: boolean): string {
  if (hasMde) return "desirability is required for a Metric that declares an MDE";
  if (isPrimary) return "desirability is required for the primary Metric";
  if (hasRope) return "desirability is required for a Metric that declares a ROPE";
  return "desirability is required for every pre-registered Metric";
}

/**
 * When the ship rule combines goals, every locked goal Metric needs
 * desirability in the freeze so combination cannot silently drop one.
 */
function lockedGoalDesirabilityIssues(
  intent: PreRegistrationIntent,
  lockedGoalMetricIds: ReadonlySet<string> | undefined,
): PreRegistrationIssue[] {
  if (lockedGoalMetricIds === undefined || intent.shipRule.conflictResolution === "primary_wins") {
    return [];
  }
  const listed = new Set(intent.metrics.map((metric) => metric.metricId));
  const issues: PreRegistrationIssue[] = [];
  for (const metricId of lockedGoalMetricIds) {
    if (listed.has(metricId)) continue;
    issues.push({
      path: ["body", "preRegistration", "metrics"],
      message: `desirability is required for locked goal Metric ${JSON.stringify(metricId)} when shipRule.conflictResolution combines goals`,
      code: "PREREG_LOCKED_GOAL_DESIRABILITY_REQUIRED",
    });
  }
  return issues;
}

function futilityIssues(intent: PreRegistrationIntent): PreRegistrationIssue[] {
  if (intent.futility !== "mde_exclusion") return [];
  const primary = intent.metrics.find((metric) => metric.metricId === intent.primaryMetricId);
  if (primary?.mdeAbsolute !== undefined) return [];
  const hasRelativeOnly = primary?.mdeRelative !== undefined;
  return [
    {
      path: ["body", "preRegistration", "futility"],
      message: hasRelativeOnly
        ? 'futility "mde_exclusion" requires an absolute MDE on the primary Metric; relative MDE alone is unsupported because sequential Fieller coverage is unproven'
        : 'futility "mde_exclusion" requires an absolute MDE on the primary Metric',
      code: "PREREG_FUTILITY_REQUIRES_ABSOLUTE_MDE",
    },
  ];
}

function freezeMetric(metric: PreRegistrationIntent["metrics"][number]): PreRegistrationMetric {
  if (metric.desirability === undefined) {
    throw new Error("freezeMetric requires desirability after validation");
  }
  return {
    metric_id: metric.metricId,
    desirability: metric.desirability,
    ...(metric.mdeAbsolute !== undefined ? { mde_absolute: metric.mdeAbsolute } : {}),
    ...(metric.mdeRelative !== undefined ? { mde_relative: metric.mdeRelative } : {}),
    ...(metric.rope !== undefined
      ? {
          rope: {
            lower: metric.rope.lower,
            upper: metric.rope.upper,
            scale: metric.rope.scale,
          },
        }
      : {}),
  };
}

/** Convert frozen form back to Start-body camelCase for Run reads. */
export function preRegistrationToIntent(frozen: PreRegistration): PreRegistrationIntent {
  return {
    hypothesis: frozen.hypothesis,
    primaryMetricId: frozen.primary_metric_id,
    metrics: frozen.metrics.map((metric) => ({
      metricId: metric.metric_id,
      desirability: metric.desirability,
      ...(metric.mde_absolute !== undefined ? { mdeAbsolute: metric.mde_absolute } : {}),
      ...(metric.mde_relative !== undefined ? { mdeRelative: metric.mde_relative } : {}),
      ...(metric.rope !== undefined ? { rope: metric.rope } : {}),
    })),
    shipRule: {
      requiredMargin: frozen.ship_rule.required_margin,
      marginScale: frozen.ship_rule.margin_scale,
      conflictResolution: frozen.ship_rule.conflict_resolution,
    },
    futility: frozen.futility,
  };
}
