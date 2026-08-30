import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EnvironmentExposureStatus } from "#components/environments/environment-exposure-status";

describe("EnvironmentExposureStatus", () => {
  it("renders an explicit loading state", () => {
    const html = renderToStaticMarkup(<EnvironmentExposureStatus state="loading" />);

    expect(html).toContain('data-testid="exposure-status-loading"');
    expect(html).toContain("Checking for your first Exposure");
  });

  it("keeps the teaching state while no Exposure has arrived", () => {
    const html = renderToStaticMarkup(<EnvironmentExposureStatus state="not_received" />);

    expect(html).toContain('data-testid="exposure-status-not-received"');
    expect(html).toContain("Run your app");
    expect(html).toContain("evaluate()");
    expect(html).not.toContain("First Exposure received");
  });

  it("shows the durable first Exposure timestamp after receipt", () => {
    const html = renderToStaticMarkup(
      <EnvironmentExposureStatus firstExposureAt="2026-08-18T12:34:56.789Z" state="received" />,
    );

    expect(html).toContain('data-testid="exposure-status-received"');
    expect(html).toContain("First Exposure received");
    expect(html).toContain('dateTime="2026-08-18T12:34:56.789Z"');
  });

  it("renders a retryable unavailable state that can never read as not_received", () => {
    const html = renderToStaticMarkup(
      <EnvironmentExposureStatus onRetry={() => {}} state="error" />,
    );

    expect(html).toContain('data-testid="exposure-status-error"');
    expect(html).toContain("Exposure status unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain('data-testid="exposure-status-not-received"');
    expect(html).not.toContain("Run your app");
  });
});
