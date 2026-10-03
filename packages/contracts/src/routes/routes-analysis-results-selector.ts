import { z } from "@hono/zod-openapi";
import { ExperimentResultsViewSchema } from "../experiment-results-readiness";

/**
 * Request selectors for experiment_results_*. Kept out of routes-analysis.ts so
 * the route table stays under the code-line ratchet.
 */

export const ResultsSelectorSchema = z
  .object({
    runId: z.string().optional(),
    /** Concise returns the verdict block only; detailed (default) keeps full stats. */
    view: ExperimentResultsViewSchema.optional(),
  })
  .strict();

const ConclusionResultsSelectorSchema = ResultsSelectorSchema.extend({
  dataWatermark: z.string().datetime({ offset: true }).optional(),
}).strict();

export const OptionalResultsSelectorSchema = ConclusionResultsSelectorSchema.default({});
