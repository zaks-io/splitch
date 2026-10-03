import { describe, expect, it } from "vitest";
import { resultsFieldsDocsUrl, resultsFieldsResourceLink } from "./mcp-results-docs";

describe("experiment results docs resource_link", () => {
  it("does not invent a docs URL when no results-fields page is published", () => {
    expect(resultsFieldsDocsUrl("experiment_results_get")).toBeUndefined();
    expect(resultsFieldsDocsUrl("experiment_results_post")).toBeUndefined();
    expect(resultsFieldsResourceLink("experiment_results_get")).toBeUndefined();
  });

  it("ignores operations that are not Experiment results reads", () => {
    expect(resultsFieldsDocsUrl("flags_get")).toBeUndefined();
  });
});
