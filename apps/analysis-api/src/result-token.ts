import { canonicalHash, resultTokenStats, type StatsOutput } from "@splitch/contracts";

interface ResultTokenInput {
  appId: string;
  environmentId: string;
  experimentId: string;
  runId: string;
  runConfigHash: string;
  stats: StatsOutput;
}

export async function createResultToken(input: ResultTokenInput): Promise<`sha256:${string}`> {
  return canonicalHash({ ...input, stats: resultTokenStats(input.stats) });
}

export type { ResultTokenInput };
