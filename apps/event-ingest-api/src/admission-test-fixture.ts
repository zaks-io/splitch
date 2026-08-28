import type { IngestAdmissionGateNamespace } from "./ingest-admission-gate";

export interface AdmissionCharge {
  readonly scope: string;
  readonly rowCost: number;
  readonly byteCost: number;
}

export type AdmissionOption = false | "throw" | { allowed: boolean; retryAfterMs: number };

export function admissionBinding(
  admission: AdmissionOption | undefined,
  charges: AdmissionCharge[],
): { INGEST_ADMISSION_GATE?: IngestAdmissionGateNamespace } {
  if (admission === false) return { INGEST_ADMISSION_GATE: undefined };
  if (admission === "throw") return { INGEST_ADMISSION_GATE: throwingAdmissionStub() };
  return {
    INGEST_ADMISSION_GATE: admissionStub(charges, admission ?? { allowed: true, retryAfterMs: 0 }),
  };
}

/** Local Event Ingest runtime bindings shared by ingest fixtures and consuming seams. */
export function localIngestRuntimeBindings(
  options: { admission?: AdmissionOption; admissionCharges?: AdmissionCharge[] } = {},
) {
  return {
    SPLITCH_PLATFORM_TARGET: "local" as const,
    SPLITCH_EVENT_INGEST_TOKEN: "internal_ingest_secret",
    TINYBIRD_API_URL: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "tb_ingest_secret",
    ...admissionBinding(options.admission, options.admissionCharges ?? []),
  };
}

function admissionStub(
  charges: AdmissionCharge[],
  decision: { allowed: boolean; retryAfterMs: number },
): IngestAdmissionGateNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get(id: DurableObjectId) {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          const body = JSON.parse(String(init?.body)) as {
            rowCost: number;
            byteCost: number;
          };
          charges.push({
            scope: String(id),
            rowCost: body.rowCost,
            byteCost: body.byteCost,
          });
          return Response.json(decision);
        },
      };
    },
  };
}

function throwingAdmissionStub(): IngestAdmissionGateNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId;
    },
    get() {
      return {
        async fetch(): Promise<Response> {
          throw new Error("Ingest Admission Gate is unavailable");
        },
      };
    },
  };
}
