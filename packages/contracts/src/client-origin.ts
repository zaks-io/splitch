import { z } from "zod";

export const ClientOriginSchema = z
  .string()
  .min(1)
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

export const OriginAllowlistSchema = z.array(ClientOriginSchema).min(1);

export const NormalizedOriginAllowlistSchema =
  OriginAllowlistSchema.transform(normalizeClientOrigins);

export function normalizeClientOrigins(origins: string[]): string[] {
  return [...new Set(OriginAllowlistSchema.parse(origins).map((origin) => new URL(origin).origin))];
}
