import { z } from "zod";
import { PERSISTED_ORIGIN_MAX_LENGTH, persistedArray } from "./persisted-field-limits";

export const ClientOriginSchema = z
  .string()
  .min(1)
  .max(PERSISTED_ORIGIN_MAX_LENGTH)
  .refine(
    (candidate) => {
      try {
        const url = new URL(candidate);
        return url.protocol === "https:" || url.hostname === "localhost";
      } catch {
        return false;
      }
    },
    { message: "expected an HTTPS origin or localhost" },
  );

export const OriginAllowlistSchema = persistedArray(ClientOriginSchema).min(1);

export const NormalizedOriginAllowlistSchema =
  OriginAllowlistSchema.transform(normalizeClientOrigins);

export function normalizeClientOrigins(origins: string[]): string[] {
  return [...new Set(OriginAllowlistSchema.parse(origins).map((origin) => new URL(origin).origin))];
}
