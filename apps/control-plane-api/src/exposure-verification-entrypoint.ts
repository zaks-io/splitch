import type {
  ConvexExposureVerificationBatchRequest,
  ConvexExposureVerificationBatchResult,
  ConvexExposureVerificationRequest,
  ConvexExposureVerificationResult,
} from "@splitch/contracts";
import { createRepository } from "@splitch/db";
import {
  loadCloudflareExposureVerificationConfig,
  loadCloudflareExposureVerificationConfigs,
} from "./cloudflare-exposure-verification";
import { durableAppIdentityResetAccess } from "./config-store-app-identity-access";
import {
  loadConvexExposureVerificationConfig,
  loadConvexExposureVerificationConfigs,
} from "./convex-exposure-verification";
import type { ControlPlaneApiEnv } from "./env";

export function loadConvexExposureVerificationConfigsFromEnv(
  env: ControlPlaneApiEnv,
  input: ConvexExposureVerificationBatchRequest,
): Promise<ConvexExposureVerificationBatchResult> {
  return loadConvexExposureVerificationConfigs(createRepository(env.DB), input);
}

export function loadConvexExposureVerificationConfigFromEnv(
  env: ControlPlaneApiEnv,
  input: ConvexExposureVerificationRequest,
): Promise<ConvexExposureVerificationResult> {
  return loadConvexExposureVerificationConfig(createRepository(env.DB), input);
}

export function loadCloudflareExposureVerificationConfigsFromEnv(
  env: ControlPlaneApiEnv,
  input: ConvexExposureVerificationBatchRequest,
): Promise<ConvexExposureVerificationBatchResult> {
  return loadCloudflareExposureVerificationConfigs(createRepository(env.DB), input);
}

export function loadCloudflareExposureVerificationConfigFromEnv(
  env: ControlPlaneApiEnv,
  input: ConvexExposureVerificationRequest,
): Promise<ConvexExposureVerificationResult> {
  return loadCloudflareExposureVerificationConfig(createRepository(env.DB), input);
}

export function resetCompromisedAppIdentityFromEnv(
  env: ControlPlaneApiEnv,
  appId: string,
  resetId: string,
): Promise<string> {
  return durableAppIdentityResetAccess(env.CONFIG_STORE_WRITER).resetCompromisedAppIdentity(
    appId,
    resetId,
  );
}
