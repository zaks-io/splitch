export function authMarkdown(issuer: string, smokeClientEnabled: boolean): string {
  const smokeLine = smokeClientEnabled
    ? "\n- Shared-preview smoke: POST client_credentials to /oauth2/token with the configured smoke client"
    : "";
  return `# splitch auth

Use one of the supported auth doors, then exchange the resulting credential at ${issuer}/oauth2/token.

- Anonymous: POST ${issuer}/agent/identity
- Claim ceremony: POST ${issuer}/agent/identity/claim
- Device flow: POST ${issuer}/oauth2/device_authorization as client_id splitch-cli (App ID or slug selector optional — cold start needs none), then poll ${issuer}/oauth2/token with the sealed device_code grant
- Rebind: POST grant_type=refresh_token with an optional app or org selector to mint a token for another resource your live membership allows
- Revoke: POST ${issuer}/oauth2/revoke
${smokeLine}
`;
}
