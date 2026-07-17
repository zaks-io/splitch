import { createFileRoute } from "@tanstack/react-router";
import { env as workerEnv } from "cloudflare:workers";
import { controlPanelBindings } from "#lib/bindings";
import { forwardClaimConsent } from "#lib/claim-consent";

export const Route = createFileRoute("/claim/consent/$attemptId")({
  component: () => (
    <main>
      <h1>Approve account linking</h1>
      <p>This approval links the provisional Organization to your signed-in identity.</p>
    </main>
  ),
  server: {
    handlers: {
      POST: ({ request, params }) =>
        forwardClaimConsent(controlPanelBindings(workerEnv), request, params.attemptId),
    },
  },
});
