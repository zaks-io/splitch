export function authMarkdown(issuer: string, smokeClientEnabled: boolean): string {
  const smokeLine = smokeClientEnabled
    ? "\n- Shared-preview smoke: POST client_credentials to /oauth2/token with the configured smoke client"
    : "";
  return `# splitch auth

Use one of the supported auth doors, then exchange the resulting credential at ${issuer}/oauth2/token.

- Anonymous: POST ${issuer}/agent/identity
- Claim ceremony: POST ${issuer}/agent/identity/claim
- Device flow: POST ${issuer}/oauth2/device_authorization with one App ID or slug selector, then poll ${issuer}/oauth2/token with the sealed device_code grant
- Revoke: POST ${issuer}/oauth2/revoke
${smokeLine}
`;
}
