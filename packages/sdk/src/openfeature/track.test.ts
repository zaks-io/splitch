import { describe, expect, it, vi } from "vitest";
import { SplitchOfrepProvider } from "./provider";

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
