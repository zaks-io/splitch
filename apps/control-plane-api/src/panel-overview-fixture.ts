import { type AppOverviewResponse, AppOverviewResponseSchema } from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import type { AnalysisResultsReader } from "./attention-analysis-reader";
import { AnalysisResultsUnavailableError } from "./attention-analysis-reader";
import { repository, USER_ID } from "./attention-rollup-fixture";
import { ids, NOW } from "./config-store-fixture-data";
import { overviewStats } from "./overview-test-fixtures";
import { panelOverviewRead } from "./panel-overview";

/** Every state gets its own counts, so a read of the wrong Run cannot pass. */
export const SIGNIFICANT = overviewStats({
  deduped: { control: 4_011, treatment: 3_989 },
  significant: true,
});
export const FAILING = overviewStats({
  deduped: { control: 7_100, treatment: 6_401 },
  srm: true,
  multipleRate: 0.037,
});
export const CALM = overviewStats({ deduped: { control: 1_204, treatment: 1_198 } });

export function readerFor(
  stats: Record<string, ReturnType<typeof overviewStats>>,
): AnalysisResultsReader {
  return {
    async read(scope) {
      return stats[scope.runId] ?? null;
    },
  };
}

export const deadReader: AnalysisResultsReader = {
  async read() {
    throw new AnalysisResultsUnavailableError("analysis is down");
  },
};

export async function overview(
  analysisResults: AnalysisResultsReader,
  input: {
    actorId?: string;
    appId?: string;
    environmentId?: string;
    /** Injectable so a test can observe which D1 reads the Overview issues. */
    repo?: Repository;
  } = {},
): Promise<Response> {
  return panelOverviewRead(
    { repo: input.repo ?? repository(), analysisResults, now: () => new Date(NOW) },
    {
      actorId: input.actorId ?? USER_ID,
      appId: input.appId ?? ids.appId,
      environmentId: input.environmentId ?? ids.environmentId,
    },
  );
}

export async function body(response: Response): Promise<AppOverviewResponse> {
  return AppOverviewResponseSchema.parse(await response.json());
}
