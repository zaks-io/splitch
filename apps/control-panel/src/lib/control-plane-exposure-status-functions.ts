import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authorizedExposureStatusClient } from "./panel-authorized-clients";

const ExposureStatusScopeSchema = z
  .object({
    appId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export const loadEnvironmentExposureStatus = createServerFn({ method: "GET" })
  .validator((data: unknown) => ExposureStatusScopeSchema.parse(data))
  .handler(async ({ data }) => {
    const authorized = await authorizedExposureStatusClient(data.environmentId);
    if (!authorized.ok) return authorized.result;
    return authorized.client.get(data);
  });
