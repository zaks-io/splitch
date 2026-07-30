import { z } from "zod";

const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

export const ApprovalRequestIdSchema = z.string().regex(new RegExp(`^apr_${ULID_PATTERN}$`));
export const ApprovalReviewIdSchema = z.string().regex(new RegExp(`^rev_${ULID_PATTERN}$`));

export type ApprovalRequestId = z.infer<typeof ApprovalRequestIdSchema>;
export type ApprovalReviewId = z.infer<typeof ApprovalReviewIdSchema>;
