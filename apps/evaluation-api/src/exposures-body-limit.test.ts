import {
  type ErrorResponse,
  EXPOSURE_BATCH_MAX_BODY_BYTES,
  type ExposureBatchResponse,
} from "@splitch/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluationRoute } from "./routes";
import { CLIENT_KEY, makeSdkRouteHarness } from "./sdk-route-test-fixtures";
import { EXPOSURE_ID_A, mintTicket, PATH } from "./exposures-test-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
});

// zod 4.5.1 installs instance methods (e.g. `safeParse`) as a lazy prototype
// getter that materializes into an own bound method on first read (zod's
// util.js `defineBound`/`own`, comment: "Members live on the prototype and
// materialize per instance on first read"). vitest's `vi.spyOn` has an "SSR"
// fallback for get-only descriptors that calls the getter with no receiver
// (`@vitest/spy`'s `spyOn`: `originalImplementation = ssr && original ? original() : original`),
// so it invokes zod's getter with `this` undefined and crashes with
// "Object.defineProperty called on non-object" (verified directly: the same
// crash reproduces by calling the raw prototype getter unbound). Touching the
// method once first — exactly what a real caller's `schema.safeParse(x)` does
// — makes zod materialize it as a normal own data property, so vi.spyOn takes
// its ordinary (non-SSR) path.
function spyOnSafeParse(schema: ReturnType<typeof evaluationRoute>["input"]) {
  void schema.safeParse;
  return vi.spyOn(schema, "safeParse");
}

describe("POST /api/sdk/exposures: raw-body byte limit", () => {
  it("rejects an over-cap Content-Length before body read, JSON, Zod, auth, or side effects", async () => {
    const { app, assignmentStore, credentialKv, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
    });
    credentialKv.getCalls.length = 0;
    const body = controlledBody(["not read"]);
    const jsonParse = vi.spyOn(JSON, "parse");
    const schemaParse = spyOnSafeParse(evaluationRoute("sdk_exposures").input);

    const response = await app.request(
      requestWithBody(body.stream, {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-length": String(EXPOSURE_BATCH_MAX_BODY_BYTES + 1),
        "content-type": "application/json",
      }),
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(parsedRequestBodies(jsonParse, "not read")).toEqual([]);
    expect(schemaParse).not.toHaveBeenCalled();
    expect(credentialKv.getCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
    expect(logger.errors).toEqual([]);
    jsonParse.mockRestore();
    const error = (await response.json()) as ErrorResponse;
    expect(response.status).toBe(400);
    expect(error).toEqual({
      code: "VALIDATION_ERROR",
      message: `Exposure batch body exceeds ${EXPOSURE_BATCH_MAX_BODY_BYTES} UTF-8 bytes`,
      details: {
        issues: [
          {
            path: ["body"],
            message: `body must be at most ${EXPOSURE_BATCH_MAX_BODY_BYTES} UTF-8 bytes`,
          },
        ],
      },
    });
  });

  it("stops a missing-length body at 32 KiB plus one without reading or retaining the suffix", async () => {
    const { app, assignmentStore, credentialKv, exposureSink, logger } = await makeSdkRouteHarness({
      liveRun: true,
    });
    credentialKv.getCalls.length = 0;
    const rejectedMarker = "must-never-be-read-or-logged";
    const body = controlledBody(["x".repeat(EXPOSURE_BATCH_MAX_BODY_BYTES), "y", rejectedMarker]);
    const jsonParse = vi.spyOn(JSON, "parse");
    const schemaParse = spyOnSafeParse(evaluationRoute("sdk_exposures").input);

    const response = await app.request(
      requestWithBody(body.stream, {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
      }),
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(parsedRequestBodies(jsonParse, "x".repeat(64))).toEqual([]);
    expect(schemaParse).not.toHaveBeenCalled();
    expect(credentialKv.getCalls).toEqual([]);
    expect(exposureSink.writes).toEqual([]);
    expect(assignmentStore.putHashedCalls).toEqual([]);
    expect(JSON.stringify(logger.errors)).not.toContain(rejectedMarker);
    jsonParse.mockRestore();
    const error = (await response.json()) as ErrorResponse;
    expect(response.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts exactly 32 KiB and rejects 32 KiB plus one", async () => {
    const ticket = await mintTicket();
    const atCap = exposureBody(ticket, EXPOSURE_BATCH_MAX_BODY_BYTES);
    const overCap = `${atCap} `;
    const accepted = await makeSdkRouteHarness({ liveRun: true });

    const acceptedResponse = await accepted.app.request(PATH, requestInit(atCap));
    const acceptedBody = (await acceptedResponse.json()) as ExposureBatchResponse;

    expect(acceptedResponse.status).toBe(202);
    expect(acceptedBody.results).toEqual([
      { exposureId: EXPOSURE_ID_A, status: "accepted", code: null },
    ]);
    expect(accepted.exposureSink.writes).toHaveLength(1);

    const rejected = await makeSdkRouteHarness({ liveRun: true });
    const rejectedResponse = await rejected.app.request(PATH, requestInit(overCap));
    const rejectedBody = (await rejectedResponse.json()) as ErrorResponse;

    expect(rejectedResponse.status).toBe(400);
    expect(rejectedBody.code).toBe("VALIDATION_ERROR");
    expect(rejected.exposureSink.writes).toEqual([]);
    expect(rejected.assignmentStore.putHashedCalls).toEqual([]);
  });

  it("keeps malformed under-cap JSON on the canonical validation error", async () => {
    const { app, exposureSink } = await makeSdkRouteHarness({ liveRun: true });

    const response = await app.request(PATH, requestInit("}{"));
    const error = (await response.json()) as ErrorResponse;

    expect(response.status).toBe(400);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.message).toBe("request failed schema validation");
    expect(exposureSink.writes).toEqual([]);
  });
});

function exposureBody(ticket: string, targetBytes: number): string {
  const body = JSON.stringify({
    exposures: [
      {
        exposureId: EXPOSURE_ID_A,
        exposureTicket: ticket,
        clientTimestamp: "2026-07-03T00:00:01.000Z",
      },
    ],
  });
  const byteLength = new TextEncoder().encode(body).length;
  if (byteLength > targetBytes) throw new Error("Exposure fixture exceeds target byte length");
  return body + " ".repeat(targetBytes - byteLength);
}

function requestInit(body: string): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${CLIENT_KEY}`,
      "content-type": "application/json",
    },
    body,
  };
}

function controlledBody(chunks: readonly string[]) {
  const remaining = [...chunks];
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = remaining.shift();
    if (chunk === undefined) {
      controller.close();
      return;
    }
    controller.enqueue(new TextEncoder().encode(chunk));
  });
  const cancel = vi.fn();
  return {
    stream: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }),
    pull,
    cancel,
  };
}

function requestWithBody(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Request {
  return new Request(`http://worker.test${PATH}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function parsedRequestBodies(parse: { mock: { calls: unknown[][] } }, prefix: string): string[] {
  return parse.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === "string" && value.startsWith(prefix));
}
