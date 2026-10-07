import { z } from "zod";

export const ConfigurationCallbackVerificationSchema = z
  .object({
    type: z.literal("callback.verify"),
    installationId: z.uuid(),
    challenge: z.uuid(),
  })
  .strict();
