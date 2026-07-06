import { Button } from "@splitch/ui/components/button";
import { WidgetErrorState } from "@splitch/ui/state/widget-error-state";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportBoundaryError } from "#lib/panel-observability";

type WidgetErrorBoundaryProps = {
  children: ReactNode;
  route: string;
};

type WidgetErrorBoundaryState = {
  error: unknown;
};

class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  override state: WidgetErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): WidgetErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, _errorInfo: ErrorInfo): void {
    reportBoundaryError("widget", error, this.props.route);
  }

  override render() {
    if (this.state.error) {
      return (
        <WidgetErrorState
          action={
            <Button onClick={() => this.setState({ error: null })} type="button" variant="outline">
              Retry
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}

export { WidgetErrorBoundary };
