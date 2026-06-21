export type VariantValue = boolean | string | number | JsonObject;

export interface JsonObject {
  readonly [key: string]: VariantValue;
}

export interface EvaluationContext {
  readonly targetingKey: string;
  readonly [attribute: string]: unknown;
}

export interface EvaluateOptions<TDefault extends VariantValue = VariantValue> {
  readonly flagKey: string;
  readonly targetingKey: string;
  readonly idType: string;
  readonly evaluationContext?: EvaluationContext;
  readonly defaultValue: TDefault;
}

export interface SplitchClientOptions {
  readonly appId: string;
  readonly baseUrl: string;
  readonly clientKey?: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

export interface SplitchClient {
  evaluate<TDefault extends VariantValue>(options: EvaluateOptions<TDefault>): Promise<TDefault>;
  peekVariant<TDefault extends VariantValue>(options: EvaluateOptions<TDefault>): Promise<TDefault>;
}

export function createSplitchClient(options: SplitchClientOptions): SplitchClient {
  const requestFetch = options.fetch ?? fetch;
  const baseUrl = new URL(options.baseUrl);
  const credential = resolveCredential(options);

  return {
    evaluate(evaluateOptions) {
      return requestVariant(
        requestFetch,
        baseUrl,
        credential,
        options.appId,
        "evaluate",
        evaluateOptions,
      );
    },

    peekVariant(evaluateOptions) {
      return requestVariant(
        requestFetch,
        baseUrl,
        credential,
        options.appId,
        "peek-evaluate",
        evaluateOptions,
      );
    },
  };
}

function resolveCredential(options: SplitchClientOptions): string {
  if (Boolean(options.clientKey) === Boolean(options.apiKey)) {
    throw new Error("splitch SDK requires exactly one clientKey or apiKey");
  }

  return options.clientKey ?? options.apiKey ?? "";
}

async function requestVariant<TDefault extends VariantValue>(
  requestFetch: typeof fetch,
  baseUrl: URL,
  credential: string,
  appId: string,
  endpoint: "evaluate" | "peek-evaluate",
  options: EvaluateOptions<TDefault>,
): Promise<TDefault> {
  try {
    const response = await requestFetch(
      new URL(`/apps/${encodeURIComponent(appId)}/${endpoint}`, baseUrl),
      {
        body: JSON.stringify({
          evaluationContext: {
            ...options.evaluationContext,
            targetingKey: options.targetingKey,
          },
          flagKey: options.flagKey,
          idType: options.idType,
          targetingKey: options.targetingKey,
        }),
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );

    if (!response.ok) {
      return options.defaultValue;
    }

    const body: unknown = await response.json();
    const variant = readVariant(body);

    return variant === undefined ? options.defaultValue : (variant as TDefault);
  } catch {
    return options.defaultValue;
  }
}

function readVariant(body: unknown): VariantValue | undefined {
  if (!isRecord(body)) {
    return undefined;
  }

  return isVariantValue(body.variant) ? body.variant : undefined;
}

function isVariantValue(value: unknown): value is VariantValue {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true;
  }

  return isRecord(value) && Object.values(value).every(isVariantValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
