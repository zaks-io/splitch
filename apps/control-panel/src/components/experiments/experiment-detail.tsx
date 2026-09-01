import type {
  PanelExperimentDetailOutput,
  PanelExperimentRun,
} from "@splitch/control-plane-sdk/panel-experiments";
import { Badge } from "@splitch/ui/components/badge";
import type { ReactNode } from "react";
import { ActiveEnvironmentBadge } from "#components/environments/active-environment-badge";
import type { ExperimentTab } from "#lib/experiments/experiment-detail-route";
import { experimentKeyRouteRef } from "#lib/experiments/experiment-route-navigation";
import { describeRunChange } from "#lib/experiments/experiment-run-diff";
import { scopedHref, type UrlScope } from "#lib/shell/app-shell-navigation";

type ExperimentDetailProps = {
  activeTab: ExperimentTab;
  children: ReactNode;
  data: PanelExperimentDetailOutput;
  scope: UrlScope;
  guarded?: boolean;
  selectedRunId?: string;
};

export function ExperimentDetail({
  activeTab,
  children,
  data,
  guarded,
  scope,
  selectedRunId,
}: ExperimentDetailProps) {
  const experimentHref = `${scopedHref(scope)}/experiments/${experimentKeyRouteRef(data.experiment.key)}`;
  const selectedRun = selectedRunId
    ? data.runs.find((run) => run.id === selectedRunId)
    : data.runs[0];
  if (selectedRunId && !selectedRun) throw new Error("Experiment Run not found");
  const viewHref = selectedRunId
    ? `${experimentHref}/runs/${encodeURIComponent(selectedRunId)}`
    : experimentHref;

  return (
    <div className="grid gap-6">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <ActiveEnvironmentBadge env={scope.env} guarded={guarded} />
            <h1 className="font-semibold text-3xl text-foreground tracking-tight">
              {data.experiment.name}
            </h1>
            <p className="text-muted-foreground text-sm">
              Controls <span className="font-medium text-foreground">{data.flag.name}</span>
            </p>
          </div>
          <LifecycleBadge status={data.experiment.status} />
        </div>
        <RunTimeline
          activeTab={activeTab}
          experimentHref={experimentHref}
          runs={data.runs}
          selectedRunId={selectedRun?.id}
        />
        <ExperimentTabs activeTab={activeTab} baseHref={viewHref} />
      </div>
      {children}
    </div>
  );
}

export function ExperimentTabStub({
  run,
  tab,
}: {
  run: PanelExperimentRun | undefined;
  tab: ExperimentTab;
}) {
  const runLabel = run ? `Run ${run.runNumber}` : "this draft";
  return (
    <section
      aria-labelledby={`${tab}-heading`}
      className="rounded-lg border border-border bg-card p-6 shadow-sm"
    >
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-[0.16em]">
        {runLabel}
      </p>
      <h2 className="mt-2 font-semibold text-foreground text-xl" id={`${tab}-heading`}>
        {tab === "results" ? "Results" : "Setup"}
      </h2>
      <p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
        {tab === "results"
          ? `Results for ${runLabel} will appear here without pooling data from other Runs.`
          : `The frozen assignment configuration for ${runLabel} will appear here.`}
      </p>
    </section>
  );
}

function RunTimeline({
  activeTab,
  experimentHref,
  runs,
  selectedRunId,
}: {
  activeTab: ExperimentTab;
  experimentHref: string;
  runs: PanelExperimentRun[];
  selectedRunId?: string;
}) {
  const newestFirstRuns = [...runs].sort((left, right) => right.runNumber - left.runNumber);
  return (
    <section aria-labelledby="run-history-heading" className="grid gap-3">
      <div>
        <h2 className="font-medium text-foreground text-sm" id="run-history-heading">
          Run history
        </h2>
        <p className="text-muted-foreground text-xs">
          Each Run is a frozen, independent analysis window.
        </p>
      </div>
      {newestFirstRuns.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed px-4 py-5 text-muted-foreground text-sm">
          No Runs yet. Start this Experiment to open Run 1.
        </div>
      ) : (
        <ol className="grid gap-3 md:grid-flow-col md:auto-cols-fr md:grid-rows-1">
          {newestFirstRuns.map((run, index) => (
            <RunNode
              activeTab={activeTab}
              experimentHref={experimentHref}
              key={run.id}
              previous={newestFirstRuns[index + 1]}
              run={run}
              selected={run.id === selectedRunId}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function RunNode({
  activeTab,
  experimentHref,
  previous,
  run,
  selected,
}: {
  activeTab: ExperimentTab;
  experimentHref: string;
  previous: PanelExperimentRun | undefined;
  run: PanelExperimentRun;
  selected: boolean;
}) {
  const href = `${experimentHref}/runs/${encodeURIComponent(run.id)}/${activeTab}`;
  return (
    <li>
      <a
        aria-current={selected ? "page" : undefined}
        className={`block h-full rounded-lg border p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          selected
            ? "border-primary bg-primary/5 shadow-sm"
            : "border-border bg-card hover:border-primary/50"
        }`}
        href={href}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium text-foreground text-sm">Run {run.runNumber}</span>
          <Badge variant={run.status === "running" ? "secondary" : "outline"}>
            {capitalize(run.status)}
          </Badge>
        </div>
        <p className="mt-2 text-muted-foreground text-xs">{dateRange(run)}</p>
        <p className="mt-3 text-foreground text-sm leading-5">{describeRunChange(run, previous)}</p>
        {run.startReason ? (
          <p className="mt-2 text-muted-foreground text-xs">Note: {run.startReason}</p>
        ) : null}
        {run.endReason ? (
          <p className="mt-1 text-muted-foreground text-xs">End note: {run.endReason}</p>
        ) : null}
      </a>
    </li>
  );
}

function ExperimentTabs({ activeTab, baseHref }: { activeTab: ExperimentTab; baseHref: string }) {
  return (
    <nav aria-label="Experiment detail tabs" className="flex gap-1 border-border border-b">
      {(["results", "setup"] as const).map((tab) => (
        <a
          aria-current={activeTab === tab ? "page" : undefined}
          className={`border-b-2 px-4 py-2.5 font-medium text-sm capitalize ${
            activeTab === tab
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          href={`${baseHref}/${tab}`}
          key={tab}
        >
          {capitalize(tab)}
        </a>
      ))}
    </nav>
  );
}

function LifecycleBadge({
  status,
}: {
  status: PanelExperimentDetailOutput["experiment"]["status"];
}) {
  return (
    <Badge variant={status === "running" ? "secondary" : "outline"}>{capitalize(status)}</Badge>
  );
}

function dateRange(run: PanelExperimentRun): string {
  return `${formatDate(run.startedAt)} → ${run.endedAt ? formatDate(run.endedAt) : "Live"}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
