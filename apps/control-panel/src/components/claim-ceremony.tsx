import { Alert, AlertDescription, AlertTitle } from "@splitch/ui/components/alert";
import { Button } from "@splitch/ui/components/button";
import { Input } from "@splitch/ui/components/input";
import { useState, type FormEvent } from "react";
import { submitClaimCeremony, type ClaimActionResult } from "#lib/claim-ceremony-functions";

export function ClaimCeremony({ orgSlug }: { orgSlug: string }) {
  const [identityAssertion, setIdentityAssertion] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "verify" | "consent">("email");
  const [result, setResult] = useState<ClaimActionResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const response = await submitClaimCeremony({
        data: {
          orgSlug,
          identityAssertion,
          email,
          otp: step === "verify" ? otp : undefined,
          completeTransfer: step === "consent",
        },
      });
      applyResponse(response);
    } catch {
      setResult({
        kind: "error",
        code: "server_error",
        message: "The claim could not be completed. Try again with the same one-time password.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function applyResponse(response: ClaimActionResult) {
    if (response.kind === "otp_required") {
      setStep("verify");
      setResult(response);
      return;
    }
    if (response.kind === "claimed") {
      window.location.assign("/");
      return;
    }
    if (response.kind === "handoff_required") {
      window.location.assign("/auth/login?returnTo=%2F");
      return;
    }
    if (response.kind === "error" && response.code === "interaction_required") {
      setStep("consent");
    }
    setResult(response);
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      {result?.kind === "otp_required" ? (
        <Alert>
          <AlertTitle>Check your email</AlertTitle>
          <AlertDescription>
            Enter the one-time password to finish claiming this Organization.
          </AlertDescription>
        </Alert>
      ) : null}
      {result?.kind === "error" ? <ClaimError result={result} /> : null}

      <label className="grid gap-2 text-sm font-medium" htmlFor="identity-assertion">
        Identity assertion
        <Input
          autoComplete="off"
          id="identity-assertion"
          onChange={(event) => setIdentityAssertion(event.target.value)}
          required
          type="password"
          value={identityAssertion}
        />
      </label>
      <label className="grid gap-2 text-sm font-medium" htmlFor="claim-email">
        Email address
        <Input
          autoComplete="email"
          id="claim-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </label>
      {step === "verify" ? (
        <label className="grid gap-2 text-sm font-medium" htmlFor="claim-otp">
          One-time password
          <Input
            autoComplete="one-time-code"
            id="claim-otp"
            onChange={(event) => setOtp(event.target.value)}
            required={step === "verify"}
            value={otp}
          />
        </label>
      ) : null}
      <Button disabled={submitting} type="submit">
        {submitting
          ? "Submitting"
          : step === "consent"
            ? "Finish approved transfer"
            : step === "verify"
              ? "Claim Organization"
              : "Send one-time password"}
      </Button>
    </form>
  );
}

function ClaimError({ result }: { result: Extract<ClaimActionResult, { kind: "error" }> }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{result.code}</AlertTitle>
      <AlertDescription>
        <p>{result.message}</p>
        {result.consentUrl ? (
          <p>
            <a href={result.consentUrl}>Approve account linking</a>
            {result.consentExpiresAt
              ? ` before ${new Date(result.consentExpiresAt).toLocaleString()}.`
              : null}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
