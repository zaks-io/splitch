import {
  type ConvexExposureVerificationBatchRequest,
  type ConvexExposureVerificationBatchResult,
  type ConvexExposureVerificationRequest,
  ConvexExposureVerificationRequestSchema,
  type ConvexExposureVerificationResult,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { loadExposureVerificationConfigs } from "./exposure-verification-batch";

export async function loadConvexExposureVerificationConfigs(
  repo: Repository,
  input: ConvexExposureVerificationBatchRequest,
): Promise<ConvexExposureVerificationBatchResult> {
  return loadExposureVerificationConfigs(repo, repo.convex, input);
}

export async function loadConvexExposureVerificationConfig(
  repo: Repository,
  input: ConvexExposureVerificationRequest,
): Promise<ConvexExposureVerificationResult> {
  const { appId, environmentId, ...item } = ConvexExposureVerificationRequestSchema.parse(input);
  const [result] = await loadConvexExposureVerificationConfigs(repo, {
    appId,
    environmentId,
    items: [item],
  });
  if (!result) throw new Error("Convex Exposure verification omitted its only result");
  return result;
}
