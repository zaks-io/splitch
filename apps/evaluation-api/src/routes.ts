import { getRoute, type RouteContract } from "@splitch/contracts";

export function evaluationRoute(operationId: string): RouteContract {
  const route = getRoute(operationId);
  if (!route) {
    throw new Error(`evaluation-api: no route "${operationId}" in the shared registry`);
  }
  if (route.owner !== "evaluation-api") {
    throw new Error(`evaluation-api: route "${operationId}" is owned by ${route.owner}`);
  }
  return route;
}
