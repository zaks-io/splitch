import { z } from "@hono/zod-openapi";
import { ExperimentResultsViewSchema } from "../experiment-results-readiness";
import { QueryBooleanSchema } from "../resource-delete-tree";

/**
 * Request selectors for experiment_results_*. Kept out of routes-analysis.ts so
 * the route table stays under the code-line ratchet.
 *
 * GET query strings are always text, so includeExploratory accepts "true" /
 * "false" (and rejects anything else) via QueryBooleanSchema. POST/MCP bodies
 * keep a real boolean.
 */

const resultsSelectorFields = {
  runId: z.string().optional(),
  /** Concise returns the verdict block only; detailed (default) keeps full stats. */
  view: ExperimentResultsViewSchema.optional(),
} as const;

/** GET query: string booleans at the wire boundary. */
export const ResultsSelectorQuerySchema = z
  .object({
    ...resultsSelectorFields,
    /**
     * Concise mode omits stats by default. Set true to attach stats (including
     * exploratory Metric p-values) on concise; detailed already includes them.
     */
    includeExploratory: QueryBooleanSchema.optional(),
  })
  .strict();

/** POST / MCP body: real JSON booleans only. */
export const ResultsSelectorSchema = z
  .object({
    ...resultsSelectorFields,
    /**
     * Concise mode omits stats by default. Set true to attach stats (including
     * exploratory Metric p-values) on concise; detailed already includes them.
     */
    includeExploratory: z.boolean().optional(),
  })
  .strict();

const ConclusionResultsSelectorSchema = ResultsSelectorSchema.extend({
  dataWatermark: z.string().datetime({ offset: true }).optional(),
}).strict();

export const OptionalResultsSelectorSchema = ConclusionResultsSelectorSchema.default({});
