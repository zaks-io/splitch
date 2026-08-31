import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@splitch/ui/components/accordion";
import { ExperimentResultsRails, RESULTS_RAIL_GRID } from "./experiment-results-arms";

export function ExperimentResultsStation({
  baseline,
  children,
  count,
  flaggedVariant,
  keyValue,
  keyValueStyle,
  keyValueTone,
  muted = false,
  siding = false,
  summary,
  title,
  value,
  variantOrder,
  warnings = [],
}: {
  baseline: string;
  children: React.ReactNode;
  count: string;
  flaggedVariant?: string;
  keyValue: string;
  keyValueStyle?: React.CSSProperties;
  keyValueTone?: string;
  muted?: boolean;
  siding?: boolean;
  summary: string;
  title: string;
  value: string;
  variantOrder: readonly string[];
  warnings?: readonly string[];
}) {
  return (
    <AccordionItem className={`${RESULTS_RAIL_GRID} border-b-0!`} value={value}>
      <ExperimentResultsRails
        baseline={baseline}
        connect={!siding}
        flaggedVariant={flaggedVariant}
        siding={siding}
        variantOrder={variantOrder}
      />
      <div className="pb-6">
        <div
          className={`rounded-lg border bg-card ${warnings.length > 0 ? "border-warning/40" : "border-border"}`}
        >
          <AccordionTrigger className="w-full rounded-lg p-5 hover:no-underline">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
                <div className="min-w-0 flex-1 basis-full sm:basis-0">
                  <span
                    className={`font-semibold text-sm ${muted ? "text-muted-foreground" : "text-foreground"}`}
                  >
                    {title}
                  </span>
                  <p className="mt-1 text-muted-foreground text-sm leading-relaxed">{summary}</p>
                </div>
                <span
                  className={`font-medium font-mono text-lg ${keyValueTone ?? (muted ? "text-muted-foreground" : "text-foreground")}`}
                  style={keyValueStyle}
                >
                  {keyValue}
                </span>
                <span className="rounded-md border border-border px-2.5 py-1 font-mono text-muted-foreground text-xs">
                  {count}
                </span>
              </div>
              {warnings.map((warning) => (
                <p
                  className="mt-4 rounded-md border border-warning/40 bg-warning-muted p-3 text-left text-warning-foreground text-sm leading-relaxed"
                  key={warning}
                >
                  <span aria-hidden="true" className="mr-1 font-mono">
                    ▲
                  </span>
                  {warning}
                </p>
              ))}
            </div>
          </AccordionTrigger>
          <AccordionContent className="border-border border-t p-5" keepMounted>
            {children}
          </AccordionContent>
        </div>
      </div>
    </AccordionItem>
  );
}
