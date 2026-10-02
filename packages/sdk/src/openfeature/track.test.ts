import { describe, expect, it, vi } from "vitest";
import { SplitchOfrepProvider } from "./provider";
import { trackMetricEvent } from "./track";

describe("SplitchOfrepProvider.track", () => {
  it("posts a Metric Event from the OpenFeature tracking API", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accepted: true,
            eventId: "123e4567-e89b-42d3-a456-426614174000",
            duplicate: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const provider = new SplitchOfrepProvider({
      baseUrl: "https://edge.example",
      credential: "pk_test",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    provider.track(
      "signed_up",
      { targetingKey: "user-1", idType: "user" },
      { value: 1, plan: "pro", eventId: "123e4567-e89b-42d3-a456-426614174000" },
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    if (init === undefined) throw new Error("expected a track fetch");
    expect(new URL(String(url)).pathname).toBe("/api/sdk/events");
    expect(JSON.parse(String(init.body))).toEqual({
      eventName: "signed_up",
      targetingKey: "user-1",
      idType: "user",
      eventId: "123e4567-e89b-42d3-a456-426614174000",
      fields: { value: 1 },
      dimensions: { plan: "pro" },
    });
  });
});

describe("trackMetricEvent", () => {
  it("rejects an invalid supplied eventId before any network request", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(
      trackMetricEvent(
        {
          credential: "pk_test",
          endpoint: "https://edge.example",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        "signed_up",
        { targetingKey: "user-1" },
        { eventId: "not-a-uuid" },
      ),
    ).rejects.toThrow(/details\.eventId must be a UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("generates an eventId only when the caller omits one", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            accepted: true,
            eventId: "123e4567-e89b-42d3-a456-426614174000",
            duplicate: false,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    await trackMetricEvent(
      {
        credential: "pk_test",
        endpoint: "https://edge.example",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      "signed_up",
      { targetingKey: "user-1" },
      { plan: "pro" },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    if (init === undefined) throw new Error("expected a track fetch");
    const body = JSON.parse(String(init.body)) as { eventId: string };
    expect(body.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("rejects unsupported dimension values before any network request", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(
      trackMetricEvent(
        {
          credential: "pk_test",
          endpoint: "https://edge.example",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
        "signed_up",
        { targetingKey: "user-1" },
        { plan: { tier: "pro" } },
      ),
    ).rejects.toThrow(/details\.plan must be a boolean, string, or finite number/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
