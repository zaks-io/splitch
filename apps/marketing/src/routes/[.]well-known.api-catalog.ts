import { createFileRoute } from "@tanstack/react-router";
import { apiCatalogResponse } from "../api-catalog";

export const Route = createFileRoute("/.well-known/api-catalog")({
  server: {
    handlers: {
      GET: async () => apiCatalogResponse("GET"),
      HEAD: async () => apiCatalogResponse("HEAD"),
    },
  },
});
