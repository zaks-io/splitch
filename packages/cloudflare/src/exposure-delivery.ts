import {
  type CloudflareServerExposureItem,
  CloudflareServerExposureResponseSchema,
  EvaluationContextSchema,
} from "@splitch/contracts";

const PRIVACY_DEADLINE_MS = 24 * 60 * 60 * 1_000;

export interface ExposureRow {
  [key: string]: string | number | null | ArrayBuffer;
  exposureId: string;
  installationId: string;
  flagKey: string;
  experimentId: string;
  runId: string;
  runConfigHash: string;
  contextJson: string;
  variantName: string;
  exposedAt: string;
  attemptCount: number;
  createdAt: number;
}

export async function deliverExposure(
  row: ExposureRow,
  endpoint: string,
  apiKey: string,
): Promise<"accepted" | "retry" | "terminal"> {
  const item: CloudflareServerExposureItem = {
    exposureId: row.exposureId,
    installationId: row.installationId,
    flagKey: row.flagKey,
    experimentId: row.experimentId,
    runId: row.runId,
    runConfigHash: row.runConfigHash,
    evaluationContext: EvaluationContextSchema.parse(JSON.parse(row.contextJson)),
    variantName: row.variantName,
    exposureAt: row.exposedAt,
  };
  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/integrations/cloudflare/exposures`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ exposures: [item] }),
      redirect: "error",
    });
  } catch {
    return "retry";
  }
  if (!response.ok)
    return response.status === 408 || response.status === 429 || response.status >= 500
      ? "retry"
      : "terminal";
  const first = await firstExposureResult(response);
  if (!first) return "retry";
  if (first.status === "accepted" || first.status === "deduplicated") return "accepted";
  return first.retryable ? "retry" : "terminal";
}

async function firstExposureResult(response: Response) {
  try {
    const result = CloudflareServerExposureResponseSchema.safeParse(await response.json());
    return result.success ? (result.data.results[0] ?? null) : null;
  } catch {
    return null;
  }
}

export function nextExposureAttempt(exposureId: string, attempt: number): number {
  const delays = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000];
  const base = delays[Math.min(attempt, delays.length - 1)] ?? 1_800_000;
  const seed = [...`${exposureId}:${attempt}`].reduce(
    (value, character) => (value * 31 + character.charCodeAt(0)) >>> 0,
    0,
  );
  return Math.round(base * (0.8 + (seed / 0xffffffff) * 0.4));
}

export function exceededPrivacyDeadline(row: Pick<ExposureRow, "createdAt">, now: number): boolean {
  return now - row.createdAt >= PRIVACY_DEADLINE_MS;
}
