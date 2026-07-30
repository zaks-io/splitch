import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute(
  "/$orgSlug/$appSlug/$env/experiments/$experimentId/runs/$runId",
)({
  component: Outlet,
});
