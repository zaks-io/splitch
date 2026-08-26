import {
  installControlPanelSentry,
  revokeControlPanelSentryInstallation,
  rotateControlPanelSentrySecret,
} from "./control-plane-sentry-functions";

/**
 * The three Sentry installation acts, normalized to what the card renders.
 *
 * A minted secret is surfaced as its own outcome rather than folded into
 * "done": it exists exactly once, so a caller that forgets to render it has
 * destroyed it. Making it a distinct branch keeps that impossible to miss.
 */
export type SentryOutcome =
  | { kind: "secret"; value: string }
  | { kind: "done" }
  | { kind: "refused"; message: string };

export async function installSentry(input: {
  orgId: string;
  installationId: string;
  webhookUrl: string;
}): Promise<SentryOutcome> {
  const result = await installControlPanelSentry({ data: input });
  if (!result.ok) return { kind: "refused", message: result.error.message };
  return mintedSecret(result.data.webhookSecret);
}

export async function rotateSentrySecret(input: {
  orgId: string;
  installationId: string;
  rotationId: string;
}): Promise<SentryOutcome> {
  const result = await rotateControlPanelSentrySecret({ data: input });
  if (!result.ok) return { kind: "refused", message: result.error.message };
  return mintedSecret(result.data.webhookSecret);
}

export async function revokeSentryInstallation(input: {
  orgId: string;
  installationId: string;
}): Promise<SentryOutcome> {
  const result = await revokeControlPanelSentryInstallation({ data: input });
  if (!result.ok) return { kind: "refused", message: result.error.message };
  return { kind: "done" };
}

/**
 * The Panel never supplies its own secret, so the server always mints one and
 * an absent value means this call was answered as a replay of an earlier one.
 * That earlier response held the only copy, so the honest answer is to say so
 * and let the operator rotate, never to render a blank secret box.
 */
function mintedSecret(value: string | undefined): SentryOutcome {
  if (value === undefined) {
    return {
      kind: "refused",
      message:
        "Sentry is already connected with a secret splitch cannot show again. Rotate the secret to get a new one.",
    };
  }
  return { kind: "secret", value };
}
