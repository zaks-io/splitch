import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExperimentResults } from "./experiment-results";
import {
  metricsFixture,
  resultsFixture,
  runFixture,
  srmFiringStats,
  statsFixture,
} from "./experiment-results-test-fixtures";

const evidence = {
  resultToken: `sha256:${"a".repeat(64)}`,
  dataWatermark: "2026-09-08T00:00:00.000Z",
};

describe("Conclude Run availability", () => {
  it("offers an action on a healthy running Run with server evidence", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        canConclude={true}
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(statsFixture(), evidence)}
      />,
    );
    expect(concludeButton(html)).not.toMatch(/\sdisabled=""/);
    expect(html).not.toContain("SPL-158");
  });

  it("retains the server gate even when evidence is present", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        canConclude={true}
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(srmFiringStats(), evidence)}
      />,
    );
    expect(concludeButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("Resolve the failing checks below");
  });

  it("does not offer a write to a member", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        canConclude={false}
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={runFixture()}
        results={resultsFixture(statsFixture(), evidence)}
      />,
    );
    expect(concludeButton(html)).toMatch(/\sdisabled=""/);
    expect(html).toContain("An App owner or admin");
  });

  it("does not offer to conclude an already ended Run", () => {
    const html = renderToStaticMarkup(
      <ExperimentResults
        canConclude={true}
        onConclude={() => {}}
        metrics={metricsFixture()}
        run={{ ...runFixture(), status: "ended" }}
        results={resultsFixture(statsFixture(), { ...evidence, runStatus: "ended" })}
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
