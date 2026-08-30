import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WidgetErrorBoundary } from "#components/shared/widget-error-boundary";

type WidgetBoundaryState = { error: unknown; retryKey: number };
type WidgetBoundaryStateUpdate =
  | Partial<WidgetBoundaryState>
  | ((state: WidgetBoundaryState) => Partial<WidgetBoundaryState>);

describe("WidgetErrorBoundary", () => {
  it("remounts children when retrying after a caught widget error", () => {
    const boundary = new WidgetErrorBoundary({
      children: createElement("div", null, "Widget ready"),
      route: "/test",
    });
    const testBoundary = boundary as unknown as {
      state: WidgetBoundaryState;
      setState: (update: WidgetBoundaryStateUpdate) => void;
    };
    testBoundary.setState = (update: WidgetBoundaryStateUpdate) => {
      const nextState = typeof update === "function" ? update(testBoundary.state) : update;
      testBoundary.state = { ...testBoundary.state, ...nextState };
    };
    testBoundary.state = { error: new Error("widget failed"), retryKey: 0 };

    const errorSurface = boundary.render() as ReactElement<{
      action: ReactElement<{ onClick: () => void }>;
    }>;
    errorSurface.props.action.props.onClick();

    expect(testBoundary.state).toMatchObject({ error: null, retryKey: 1 });
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toContain("Widget ready");
  });
});
