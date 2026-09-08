import { z } from "zod";

export const UnsupportedMediaTypeDetailsSchema = z
  .object({
    receivedMediaType: z.string().nullable(),
    supportedMediaTypes: z.array(z.string()).min(1),
  })
  .strict();
