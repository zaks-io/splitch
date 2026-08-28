import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVEX_WEBHOOK_MAX_BODY_BYTES, handleConfigurationWebhook } from "./configuration-webhook";
import { hmacHex } from "./crypto";

const SECRET = "webhook-secret-for-tests";
const DELIVERY_ID = "018f7a42-8c11-7c5a-9d4e-123456789abc";
const TIMESTAMP = "1780000000";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Convex configuration webhook body bound", () => {
  it("rejects a declared over-limit body before HMAC or JSON parse", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const deps = webhookDeps();
    const body = controlledBody(["must-not-be-read"]);

    const response = await handleConfigurationWebhook(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": String(CONVEX_WEBHOOK_MAX_BODY_BYTES + 1),
        "splitch-timestamp": TIMESTAMP,
        "splitch-signature": "v1=deadbeef",
        "splitch-delivery-id": DELIVERY_ID,
      }),
      deps,
    );

    expect(body.pull).not.toHaveBeenCalled();
    expect(parsedRequestBodies(parse, "must-not")).toEqual([]);
    expect(deps.getIntegration).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid body");
  });

  it("stops a chunked over-limit body at the first over-cap byte", async () => {
    const rejectedMarker = "must-never-be-read-or-logged";
    const deps = webhookDeps();
    const body = controlledBody(["x".repeat(CONVEX_WEBHOOK_MAX_BODY_BYTES), "y", rejectedMarker]);

    const response = await handleConfigurationWebhook(
      requestWithBody(body.stream, {
        "content-type": "application/json",
        "content-length": "not-a-number",
        "splitch-timestamp": TIMESTAMP,
        "splitch-signature": "v1=deadbeef",
      }),
      deps,
    );

    expect(body.pull).toHaveBeenCalledTimes(2);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(deps.getIntegration).not.toHaveBeenCalled();
    expect(deps.announce).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid body");
  });

  it("HMACs the exact at-limit bytes and accepts a valid signed nudge", async () => {
    const raw = atCapChanged(CONVEX_WEBHOOK_MAX_BODY_BYTES);
    const signature = await hmacHex(SECRET, `${TIMESTAMP}.${raw}`);
    const deps = webhookDeps();

    const response = await handleConfigurationWebhook(
      new Request("https://convex.test/configuration", {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "splitch-timestamp": TIMESTAMP,
          "splitch-signature": `v1=${signature}`,
          "splitch-delivery-id": DELIVERY_ID,
        },
        body: raw,
      }),
      deps,
    );

    expect(response.status).toBe(202);
    expect(deps.announce).toHaveBeenCalledWith({
      deliveryId: DELIVERY_ID,
      appId: "app_1",
      environmentId: "env_1",
      environmentVersion: 7,
    });
  });

  it("rejects an unsupported content type before HMAC or JSON parse", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const deps = webhookDeps();

    const response = await handleConfigurationWebhook(
      new Request("https://convex.test/configuration", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "splitch-timestamp": TIMESTAMP,
          "splitch-signature": "v1=deadbeef",
        },
        body: changedBody(),
      }),
      deps,
    );

    expect(parsedRequestBodies(parse, '{"deliveryId"')).toEqual([]);
    expect(deps.getIntegration).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid body");
  });

  it("keeps malformed under-cap JSON on the invalid-body path after HMAC", async () => {
    const raw = "}{";
    const signature = await hmacHex(SECRET, `${TIMESTAMP}.${raw}`);
    const deps = webhookDeps();

    const response = await handleConfigurationWebhook(
      new Request("https://convex.test/configuration", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "splitch-timestamp": TIMESTAMP,
          "splitch-signature": `v1=${signature}`,
        },
        body: raw,
      }),
      deps,
    );

    expect(deps.getIntegration).toHaveBeenCalledTimes(1);
    expect(deps.announce).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid body");
  });
});

function webhookDeps() {
  return {
    nowSeconds: () => Number(TIMESTAMP),
    getIntegration: vi.fn(async () => ({ webhookSecret: SECRET })),
    announce: vi.fn(async () => {}),
  };
}

function changedBody(): string {
  return JSON.stringify({
    deliveryId: DELIVERY_ID,
    type: "config.changed",
    appId: "app_1",
    environmentId: "env_1",
    environmentVersion: 7,
    changed: { entity: "flag", id: "flag_1" },
  });
}

function atCapChanged(maxBytes: number): string {
  const raw = JSON.stringify({
    deliveryId: DELIVERY_ID,
    type: "config.changed",
    appId: "app_1",
    environmentId: "env_1",
    environmentVersion: 7,
    changed: { entity: "flag", id: "flag_1" },
  });
  const pad = maxBytes - new TextEncoder().encode(raw).length;
  if (pad < 0) throw new Error("fixture exceeds target byte length");
  return `${raw}${" ".repeat(pad)}`;
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
  return new Request("https://convex.test/configuration", {
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
