import type { ErrorCode, ResolutionDetails, VariantValue } from "@splitch/contracts";

export type CloudflareAttributeValue = boolean | string | number | readonly unknown[];

export interface CloudflareEvaluationContext {
  readonly targetingKey: string;
  readonly idType?: string;
  readonly attributes?: Readonly<Record<string, CloudflareAttributeValue>>;
  readonly defaultValue?: VariantValue;
  readonly idempotencyKey: string;
}

export interface CloudflareRuntimeStatus {
  readonly installationId: string;
  readonly state: "not_ready" | "active";
  readonly appId: string | null;
  readonly environmentId: string | null;
  readonly appliedEnvironmentVersion: number | null;
  readonly pendingExposureCount: number;
  readonly terminalExposureCount: number;
}

export type CloudflareResolutionDetails = Omit<ResolutionDetails, "errorCode"> & {
  readonly errorCode?: ErrorCode | "PROVIDER_NOT_READY";
};

export interface SplitchCloudflareService {
  evaluate(flagKey: string, context: CloudflareEvaluationContext): Promise<VariantValue>;
  evaluateDetails(
    flagKey: string,
    context: CloudflareEvaluationContext,
  ): Promise<CloudflareResolutionDetails>;
  status(): Promise<CloudflareRuntimeStatus>;
}
