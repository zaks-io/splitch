import type {
  ConvexExposureVerificationBatchRequest,
  ConvexExposureVerificationBatchResult,
  ConvexExposureVerificationRequest,
  ConvexExposureVerificationResult,
} from "@splitch/contracts";
import type { Repository } from "@splitch/db";
import { loadExposureVerificationConfigs } from "./exposure-verification-batch";

export async function loadCloudflareExposureVerificationConfigs(
  repo: Repository,
  input: ConvexExposureVerificationBatchRequest,
): Promise<ConvexExposureVerificationBatchResult> {
  return loadExposureVerificationConfigs(repo, repo.cloudflare, input);
}

export async function loadCloudflareExposureVerificationConfig(
  repo: Repository,
  input: ConvexExposureVerificationRequest,
): Promise<ConvexExposureVerificationResult> {
  const { appId, environmentId, ...item } = input;
  const [result] = await loadCloudflareExposureVerificationConfigs(repo, {
    appId,
    environmentId,
    items: [item],
  });
  if (!result) throw new Error("Cloudflare Exposure verification omitted its only result");
  return result;
}
