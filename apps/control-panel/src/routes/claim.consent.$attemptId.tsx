import { env as workerEnv } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { controlPanelBindings } from "#lib/shared/bindings";
import {
  consentLoginRedirect,
  forwardClaimConsent,
  renderConsentPage,
} from "#lib/claims/claim-consent";
import { loadSessionFromRequest } from "#lib/sessions/session-refresh";

export const Route = createFileRoute("/claim/consent/$attemptId")({
  component: () => (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <main>
        <h1>Approve account linking</h1>
        <p>This approval links the provisional Organization to your signed-in identity.</p>
      </main>
    </div>
  ),
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const bindings = controlPanelBindings(workerEnv);
        const loaded = await loadSessionFromRequest(bindings, request);
        if (!loaded.ok || !loaded.session.workosAccessToken) return consentLoginRedirect(request);
        return renderConsentPage(params.attemptId);
      },
      POST: ({ request, params }) =>
        forwardClaimConsent(controlPanelBindings(workerEnv), request, params.attemptId),
    },
  },
});
