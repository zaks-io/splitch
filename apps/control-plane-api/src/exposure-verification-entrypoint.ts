import { WorkerEntrypoint } from "cloudflare:workers";
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

export class ExposureVerificationEntrypoint extends WorkerEntrypoint<ControlPlaneApiEnv> {
  async loadConvexExposureVerificationConfigs(
    input: ConvexExposureVerificationBatchRequest,
  ): Promise<ConvexExposureVerificationBatchResult> {
    return loadConvexExposureVerificationConfigs(createRepository(this.env.DB), input);
  }

  async loadConvexExposureVerificationConfig(
    input: ConvexExposureVerificationRequest,
  ): Promise<ConvexExposureVerificationResult> {
    return loadConvexExposureVerificationConfig(createRepository(this.env.DB), input);
  }

  async loadCloudflareExposureVerificationConfigs(
    input: ConvexExposureVerificationBatchRequest,
  ): Promise<ConvexExposureVerificationBatchResult> {
    return loadCloudflareExposureVerificationConfigs(createRepository(this.env.DB), input);
  }

  async loadCloudflareExposureVerificationConfig(
    input: ConvexExposureVerificationRequest,
  ): Promise<ConvexExposureVerificationResult> {
    return loadCloudflareExposureVerificationConfig(createRepository(this.env.DB), input);
  }

  resetCompromisedAppIdentity(appId: string, resetId: string): Promise<string> {
    return durableAppIdentityResetAccess(this.env.CONFIG_STORE_WRITER).resetCompromisedAppIdentity(
      appId,
      resetId,
    );
  }
}
