import { Button } from "@splitch/ui/components/button";
import { WidgetErrorState } from "@splitch/ui/state/widget-error-state";
import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { reportBoundaryError } from "#lib/panel-observability";

type WidgetErrorBoundaryProps = {
  children: ReactNode;
  route: string;
};

type WidgetErrorBoundaryState = {
  error: unknown;
  retryKey: number;
};

class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  override state: WidgetErrorBoundaryState = { error: null, retryKey: 0 };

  static getDerivedStateFromError(error: unknown): Pick<WidgetErrorBoundaryState, "error"> {
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
            <Button onClick={this.retry} type="button" variant="outline">
              Retry
            </Button>
          }
        />
      );
    }
    return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
  }

  private retry = () => {
    this.setState((state) => ({ error: null, retryKey: state.retryKey + 1 }));
  };
}

export { WidgetErrorBoundary };
