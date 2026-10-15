import { cleanScenario, srmFiringScenario } from "@splitch/contracts/testing";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResults } from "./experiment-results";
import { metricsFixture, resultsFixture, runFixture } from "./experiment-results-test-fixtures";

const evidence = {
  resultToken: `sha256:${"a".repeat(64)}`,
  dataWatermark: "2026-09-08T00:00:00.000Z",
};
const executable = { readiness: { statistical: true, concludeExecutable: true } };

describe("Conclude Run availability", () => {
  it("offers an action on a healthy running Run with server evidence", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(cleanScenario(), { ...evidence, ...executable })}
      />,
    );
    expect(concludeButton(html)).not.toMatch(/\sdisabled=""/);
    expect(html).not.toContain("SPL-158");
  });

  it("retains the server gate even when evidence is present", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(srmFiringScenario(), evidence)}
      />,
    );
    expect(concludeButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("Resolve the failing checks below");
  });

  it("does not offer a write when the producer reports concludeExecutable false", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(cleanScenario(), evidence)}
      />,
    );
    expect(concludeButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("An App owner or admin");
  });

  it("ignores a stale page-scope admin role when Results concludeExecutable is false", () => {
    // Scope may still say admin after a downgrade; Conclude follows the Results
    // producer read, which re-checks live membership.
    const html = renderToStaticMarkup(
      <ExperimentResults
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(cleanScenario(), {
          ...evidence,
          readiness: { statistical: true, concludeExecutable: false },
          reasons: ["Conclude requires App owner or admin membership for this caller."],
        })}
      />,
    );
    expect(concludeButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("An App owner or admin");
  });

  it("does not offer to conclude an already ended Run", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={{ ...runFixture(), status: "ended" }}
        results={resultsFixture(cleanScenario(), {
          ...evidence,
          runStatus: "ended",
          readiness: { statistical: true, concludeExecutable: false },
        })}
      />,
    );
    expect(concludeButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("This Run has ended.");
  });
});

function concludeButton(html: string) {
  const button = (html.match(/<button[\s\S]*?<\/button>/g) ?? []).find((entry) =>
    entry.includes("Conclude Run"),
  );
  if (!button) throw new Error("Conclude Run button is missing");
  return button;
}
