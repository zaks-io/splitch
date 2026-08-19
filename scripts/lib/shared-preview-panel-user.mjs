/**
 * Provisioning for the Control Panel hosted-smoke login identity.
 *
 * The Control Panel session principal is the WorkOS user id itself, so a hosted panel
 * smoke needs a real AuthKit account. The password is minted fresh on every run and
 * handed to the smoke step in-process: nothing long-lived is stored, and no new
 * repository or environment secret has to exist for the login to work.
 */

import { randomBytes } from "node:crypto";

export const PANEL_SMOKE_EMAIL = "panel-smoke@shared-preview.splitch.dev";

const WORKOS_BASE_URL = "https://api.workos.com";

/** 43 base64url characters of CSPRNG output; well past any AuthKit strength policy. */
export function generatePanelPassword() {
  return randomBytes(32).toString("base64url");
}

/**
 * Ensures the AuthKit smoke account exists with a verified email and a known password.
 * Returns the WorkOS user id plus the freshly minted password.
 */
export async function ensurePanelSmokeUser({
  apiKey,
  baseUrl = WORKOS_BASE_URL,
  email = PANEL_SMOKE_EMAIL,
  fetchImpl = fetch,
  password = generatePanelPassword(),
}) {
  if (!apiKey) {
    throw new Error(
      "WORKOS_API_KEY is required to provision the Control Panel smoke login. " +
        "Add it to the GitHub `preview` environment before running the panel smoke.",
    );
  }

  const request = workosRequest({ apiKey, baseUrl, fetchImpl });
  const existing = await findUserByEmail(request, email);
  const user = existing
    ? await request(`/user_management/users/${encodeURIComponent(existing)}`, {
        body: { email_verified: true, password },
        method: "PUT",
      })
    : await request("/user_management/users", {
        body: { email, email_verified: true, password },
        method: "POST",
      });

  if (typeof user?.id !== "string") {
    throw new Error("WorkOS user response is missing an id");
  }
  if (user.email_verified !== true) {
    throw new Error(
      `WorkOS smoke user ${user.id} is not email-verified; AuthKit login will be refused`,
    );
  }
  return { email, password, userId: user.id };
}

async function findUserByEmail(request, email) {
  const response = await request(`/user_management/users?email=${encodeURIComponent(email)}`, {
    allowNotFound: true,
    method: "GET",
  });
  const found = Array.isArray(response?.data) ? response.data[0] : undefined;
  return typeof found?.id === "string" ? found.id : null;
}

function workosRequest({ apiKey, baseUrl, fetchImpl }) {
  return async (path, { allowNotFound = false, body, method }) => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      method,
    });
    if (allowNotFound && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(await provisioningFailure(response, method, path));
    }
    return await response.json();
  };
}

/**
 * WorkOS refuses password writes outright when the AuthKit environment has no password
 * connection, which is a dashboard setting no credential in CI can change. Say so.
 */
async function provisioningFailure(response, method, path) {
  const detail = await readErrorDetail(response);
  const base = `WorkOS ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`;
  if (response.status === 422 && /password/i.test(detail)) {
    return `${base}\nEnable the Email + Password authentication method for this AuthKit environment in the WorkOS Dashboard (User Management -> Authentication), then re-run.`;
  }
  return base;
}

async function readErrorDetail(response) {
  try {
    const body = await response.text();
    return body.slice(0, 500);
  } catch {
    return "";
  }
}
