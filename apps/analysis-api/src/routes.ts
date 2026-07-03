import { getRoute, type RouteContract } from "@splitch/contracts";

export function analysisRoute(operationId: string): RouteContract {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`analysis-api: no route "${operationId}" in the shared registry`);
  }
  if (route.owner !== "analysis-api") {
    throw new Error(`analysis-api: route "${operationId}" is owned by ${route.owner}`);
  }
  return route;
}
