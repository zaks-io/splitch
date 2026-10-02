import { evaluateOfrepFlag, type OfrepHttpConfig } from "./http";
import { trackMetricEvent } from "./track";
import type {
  OfrepEvaluationContext,
  OfrepLogger,
  OfrepResolutionDetails,
  OfrepTrackingDetails,
  SplitchOfrepProviderOptions,
} from "./types";

/**
 * OpenFeature-shaped Provider that talks OFREP Core. Compatible with
 * `OpenFeature.setProvider()` without importing `@openfeature/server-sdk`.
 */
export class SplitchOfrepProvider {
  readonly metadata = { name: "splitch-ofrep" };
  readonly runsOn = "server" as const;
  private readonly http: OfrepHttpConfig;
  private readonly logger: OfrepLogger;

  constructor(options: SplitchOfrepProviderOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new Error("SplitchOfrepProvider baseUrl must be a valid URL");
    }
    this.http = {
      baseUrl: parsed.origin,
      credential: options.credential,
      timeoutMs: options.timeoutMs ?? 10_000,
      fetchImpl: options.fetch ?? fetch,
      headers: options.headers ?? {},
    };
    this.logger = options.logger ?? console;
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: OfrepEvaluationContext,
  ): Promise<OfrepResolutionDetails<boolean>> {
    return this.resolveTyped(flagKey, defaultValue, context, "boolean");
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: OfrepEvaluationContext,
  ): Promise<OfrepResolutionDetails<string>> {
    return this.resolveTyped(flagKey, defaultValue, context, "string");
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: OfrepEvaluationContext,
  ): Promise<OfrepResolutionDetails<number>> {
    return this.resolveTyped(flagKey, defaultValue, context, "number");
  }

  resolveObjectEvaluation(
    flagKey: string,
    defaultValue: Record<string, unknown>,
    context: OfrepEvaluationContext,
  ): Promise<OfrepResolutionDetails<Record<string, unknown>>> {
    return this.resolveTyped(flagKey, defaultValue, context, "object");
  }

  track(
    trackingEventName: string,
    context: OfrepEvaluationContext,
    details: OfrepTrackingDetails = {},
  ): void {
    void trackMetricEvent(
      {
        credential: this.http.credential,
        endpoint: this.http.baseUrl,
        fetchImpl: this.http.fetchImpl,
      },
      trackingEventName,
      context,
      details,
    ).catch((cause) => {
      this.logger.error("splitch OFREP track failed", cause);
    });
  }

  private async resolveTyped<T>(
    flagKey: string,
    defaultValue: T,
    context: OfrepEvaluationContext,
    expected: "boolean" | "string" | "number" | "object",
  ): Promise<OfrepResolutionDetails<T>> {
    const resolved = await evaluateOfrepFlag(this.http, flagKey, context);
    if (resolved.reason === "ERROR") {
      return { ...resolved, value: defaultValue };
    }
    if (resolved.value === undefined) {
      return { ...resolved, value: defaultValue, reason: resolved.reason ?? "DEFAULT" };
    }
    if (!matchesType(resolved.value, expected)) {
      return {
        value: defaultValue,
        reason: "ERROR",
        errorCode: "TYPE_MISMATCH",
        errorMessage: `OFREP value for ${flagKey} is not a ${expected}`,
      };
    }
    return { ...resolved, value: resolved.value as T };
  }
}

function matchesType(
  value: unknown,
  expected: "boolean" | "string" | "number" | "object",
): boolean {
  if (expected === "object") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  return typeof value === expected;
}
