import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StaleSessionNotice } from "#components/sessions/stale-session-notice";

// SPL-203 fix round: the review's should-fix flagged that
// `data-testid="{resource}-session-stale"` and the reason span were unasserted
// on both branches. Full remedy x resource coverage below.

describe("StaleSessionNotice", () => {
  it("offers reauth for an Organization when the fault is the session's own identity", () => {
    const html = renderToStaticMarkup(
      <StaleSessionNotice
        reason="control-panel session is missing its WorkOS session identifier"
        remedy="reauth"
        resource="Organization"
        slug="kiln-works"
      />,
    );

    expect(html).toContain('data-testid="organization-session-stale"');
    expect(html).toContain("Organization &quot;kiln-works&quot; was created");
    expect(html).toContain(
      "The Control Plane said: control-panel session is missing its WorkOS session identifier",
    );
    expect(html).toContain('data-testid="session-stale-reason"');
    expect(html).toContain('action="/auth/logout" method="post"');
    expect(html).not.toContain('href="/auth/logout"');
    expect(html).toContain("Sign in again to continue");
    expect(html).not.toContain('data-testid="session-stale-reload"');
  });

  it("offers a non-destructive reload for an Organization when reauth would not fix it", () => {
    const html = renderToStaticMarkup(
      <StaleSessionNotice
        reason="duplicate organization URL handle for authenticated user"
        remedy="retry"
        resource="Organization"
        slug="kiln-works"
      />,
    );

    expect(html).toContain('data-testid="organization-session-stale"');
    expect(html).toContain('data-testid="session-stale-reason"');
    expect(html).toContain(
      "The Control Plane said: duplicate organization URL handle for authenticated user",
    );
    expect(html).toContain('data-testid="session-stale-reload"');
    expect(html).toContain("Reload to check again");
    expect(html).not.toContain("/auth/logout");
  });

  it("offers reauth for an App when the fault is the session's own identity", () => {
    const html = renderToStaticMarkup(
      <StaleSessionNotice
        reason="refreshSession: session already expired"
        remedy="reauth"
        resource="App"
        slug="checkout-api"
      />,
    );

    expect(html).toContain('data-testid="app-session-stale"');
    expect(html).toContain("App &quot;checkout-api&quot; was created");
    expect(html).toContain("The Control Plane said: refreshSession: session already expired");
    expect(html).toContain('action="/auth/logout" method="post"');
    expect(html).not.toContain('href="/auth/logout"');
    expect(html).not.toContain('data-testid="session-stale-reload"');
  });

  it("offers a non-destructive reload for an App when reauth would not fix it", () => {
    const html = renderToStaticMarkup(
      <StaleSessionNotice
        reason="unknown App role in session materialization"
        remedy="retry"
        resource="App"
        slug="checkout-api"
      />,
    );

    expect(html).toContain('data-testid="app-session-stale"');
    expect(html).toContain("The Control Plane said: unknown App role in session materialization");
    expect(html).toContain('data-testid="session-stale-reload"');
    expect(html).toContain("Reload to check again");
    expect(html).not.toContain("/auth/logout");
  });

  it("names the key, not the handle, as the thing already taken for an App", () => {
    const html = renderToStaticMarkup(
      <StaleSessionNotice reason="boom" remedy="retry" resource="App" slug="checkout-api" />,
    );

    expect(html).toContain("the key is already taken");
  });

  it("names the handle, not the key, as the thing already taken for an Organization", () => {
    const html = renderToStaticMarkup(
      <StaleSessionNotice reason="boom" remedy="retry" resource="Organization" slug="kiln-works" />,
    );

    expect(html).toContain("the handle is already taken");
  });
});
