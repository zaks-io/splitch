import { describe, expect, it } from "vitest";
import { apiCatalog, apiCatalogResponse } from "./api-catalog";

describe("RFC 9727 API catalog", () => {
  it("describes every public API surface", () => {
    expect(apiCatalog.linkset.map(({ anchor }) => anchor)).toEqual([
      "https://api.splitch.dev",
      "https://edge.splitch.dev",
    ]);

    for (const entry of apiCatalog.linkset) {
      expect(entry["service-desc"]).toEqual([
        {
          href: "https://api.splitch.dev/.well-known/openapi.json",
          type: "application/json",
        },
      ]);
      expect(entry["service-doc"]).toHaveLength(1);
      expect(entry.status).toHaveLength(1);
    }
  });

  it("serves Linkset JSON with the catalog relation", async () => {
    const response = apiCatalogResponse("GET");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    expect(response.headers.get("link")).toBe(
      '<https://splitch.dev/.well-known/api-catalog>; rel="api-catalog"',
    );
    expect(await response.json()).toEqual(apiCatalog);
  });

  it("serves the RFC-required HEAD response without a body", async () => {
    const response = apiCatalogResponse("HEAD");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/linkset+json");
    expect(await response.text()).toBe("");
  });
});
