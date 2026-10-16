# Next SDK release

## Control Plane contracts

`@splitch/sdk/control-plane` adds the Personal Access Token step-up contracts. Creating, widening,
or rotating a token beyond the calling session's own authority, or issuing a token that never
expires, now needs a fresh browser approval. Narrowing grants, shortening expiry, listing, and
revoking never need one.

- `personalAccessTokenNeedsStepUp` and `personalAccessTokenStepUpReason` decide whether a token
  create, update, or rotate needs step-up, and why. `PersonalAccessTokenStepUpInput` describes
  their input, and `personalAccessTokenAppOrganizationLookups` lists the Apps whose Organization
  must be known to decide.
- `PAT_MANAGEMENT_AUTHORIZATION` (`"pat-management"`) is a new `AccessTokenAuthorization` value for
  the single-use step-up token, which expires within `PERSONAL_ACCESS_TOKEN_STEP_UP_TTL_SECONDS`
  (300).
- The create, update, and rotate route contracts accept an optional
  `PERSONAL_ACCESS_TOKEN_AUTHORIZATION_HEADER` (`Splitch-PAT-Authorization`) request header that
  carries the step-up token. The `Authorization` bearer remains the original session.
- A refusal for missing step-up keeps its `403 FORBIDDEN` body and adds the
  `PERSONAL_ACCESS_TOKEN_STEP_UP_CHALLENGE` value in `WWW-Authenticate`, following the
  [OAuth 2.0 step-up challenge](https://www.rfc-editor.org/rfc/rfc9470) pattern.

`AccessTokenAuthorization` now has two members. TypeScript code that switches exhaustively over it
needs a `pat-management` case. No export was removed.
