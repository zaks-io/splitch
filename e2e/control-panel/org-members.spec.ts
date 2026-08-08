import { expect, type Page, type Request, test } from "@playwright/test";
import {
  LOCAL_E2E_MEMBER_SESSION_TOKEN,
  LOCAL_E2E_PROFILELESS_USER_ID,
  LOCAL_E2E_RECRUIT_USER_ID,
  LOCAL_E2E_SESSION_TOKEN,
} from "../../scripts/local-e2e-fixtures.mjs";
import { requireForbiddenResponse } from "./forbidden-response";
import { waitForHydration } from "./hydration";
import { captureThemeScreenshots } from "./screenshot";

const origin = "http://127.0.0.1:18793";
const owner = "user_local_e2e";
const member = "user_local_member_e2e";
// Nobody by this id exists, so an add addressed to them refuses without writing
// anything. That makes the request capturable for the forced-call legs below
// without leaving a membership behind.
const absentUser = "user_never_seeded_e2e";

test.describe("Organization Members", () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ name: "__session", value: LOCAL_E2E_SESSION_TOKEN, url: origin }]);
  });

  test("an owner sees the roster, and the last owner cannot demote themselves", async ({
    page,
  }, testInfo) => {
    await page.goto("/acme-labs/members");
    await waitForHydration(page);

    const ownerRow = page.locator(`[data-member-id='${owner}']`);
    await expect(ownerRow).toContainText("owner@acme-labs.e2e");
    await expect(ownerRow).toContainText(owner);
    await expect(ownerRow.getByText("You", { exact: true })).toBeVisible();
    await expect(page.locator(`[data-member-id='${member}']`)).toContainText(
      "member@acme-labs.e2e",
    );
    await expect(page.locator(`[data-member-id='${LOCAL_E2E_PROFILELESS_USER_ID}']`)).toContainText(
      "Has not signed in yet",
    );

    // The Worker refuses LAST_OWNER_REQUIRED; the screen says so before the click
    // rather than letting the refusal be the first the owner hears of it.
    await expect(page.getByTestId(`member-role-${owner}`)).toHaveCount(0);
    await expect(page.getByTestId(`member-remove-${owner}`)).toHaveCount(0);
    await expect(ownerRow).toContainText("The only owner. Promote another member to owner first.");
    await expect(page.getByTestId(`member-remove-${member}`)).toBeEnabled();

    // Owner-only affordances are offered; the owner-only SSO row is not locked.
    await expect(page.getByTestId("add-member")).toBeVisible();
    await expect(page.getByTestId("sso-trusted-idps")).not.toContainText("Locked");

    await captureThemeScreenshots(page, testInfo, "org-members-owner");
  });

  test("an owner adds a member, changes their role, and removes them", async ({ page }) => {
    await page.goto("/acme-labs/members");
    await waitForHydration(page);

    await addMember(page, LOCAL_E2E_RECRUIT_USER_ID);
    const row = page.locator(`[data-member-id='${LOCAL_E2E_RECRUIT_USER_ID}']`);
    await expect(row).toContainText("recruit@acme-labs.e2e");
    await expect(row).toContainText("Member");

    await page.getByTestId(`member-role-${LOCAL_E2E_RECRUIT_USER_ID}`).click();
    await page.getByRole("option", { name: "Admin" }).click();
    // Re-read, never patch: the role cell below is reloaded route data, not the
    // mutation's own response spliced into the table.
    await expect(row.locator("td").nth(1)).toContainText("Admin");

    await page.getByTestId(`member-remove-${LOCAL_E2E_RECRUIT_USER_ID}`).click();
    await expect(row).toHaveCount(0);
    await page.reload();
    await expect(row).toHaveCount(0);
  });

  test("adding an existing member reports the conflict and keeps the dialog open", async ({
    page,
  }) => {
    await page.goto("/acme-labs/members");
    await waitForHydration(page);

    await addMember(page, member);

    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByTestId("add-member-error")).toContainText(
      "This person is already a member with the Member role.",
    );
  });

  test("a member sees membership locked, and the Worker refuses a forced add", async ({
    browser,
    page,
  }) => {
    await page.goto("/acme-labs/members");
    const captured = await captureAddRequest(page, absentUser);

    const memberPage = await signedInPage(browser, LOCAL_E2E_MEMBER_SESSION_TOKEN);
    await memberPage.goto("/acme-labs/members");

    // Locked with the reason, never an empty table that reads as an Organization
    // of one (ADR-0036).
    await expect(memberPage.getByTestId("members-locked")).toContainText(
      "Only owners and admins can view Organization membership.",
    );
    await expect(memberPage.locator("table")).toHaveCount(0);
    await expect(memberPage.getByTestId("add-member-locked")).toContainText(
      "Adding a member requires the Owner or Admin role.",
    );
    await expect(memberPage.getByRole("button", { name: /add member/i })).toHaveCount(0);
    await expect(memberPage.getByTestId("sso-configure")).toContainText("Locked");
    await expect(memberPage.getByTestId("sso-trusted-idps")).toContainText("Locked");

    const forced = await memberPage.request.fetch(captured.url(), {
      method: "POST",
      headers: captured.headers(),
      data: captured.postData() ?? "",
    });
    await requireForbiddenResponse(forced);

    await memberPage.context().close();
  });

  test("an admin may add members but is refused a role change and an owner grant", async ({
    page,
  }) => {
    // The same signed-in User is an owner of acme-labs and an admin of
    // orbit-tools, so this leg proves the gate follows the Organization rather
    // than the person.
    await page.goto("/orbit-tools/members");
    await waitForHydration(page);

    await expect(page.locator(`[data-member-id='${owner}']`)).toContainText("owner@acme-labs.e2e");
    await expect(page.getByTestId("add-member")).toBeVisible();
    await expect(page.getByTestId(`member-actions-locked-${owner}`)).toContainText(
      "Changing roles and removing members requires the Owner role.",
    );
    await expect(page.getByTestId(`member-role-${owner}`)).toHaveCount(0);
    await expect(page.getByTestId(`member-remove-${owner}`)).toHaveCount(0);
    // Owner-only SSO configuration is locked for the same role.
    await expect(page.getByTestId("sso-trusted-idps")).toContainText("Locked");

    const captured = await captureAddRequest(page, absentUser);
    const asOwnerGrant = forceOwnerRole(captured.postData() ?? "");

    const forced = await page.request.fetch(captured.url(), {
      method: "POST",
      headers: captured.headers(),
      data: asOwnerGrant,
    });
    await requireForbiddenResponse(forced);
  });
});

async function addMember(page: Page, userId: string): Promise<void> {
  await page.getByTestId("add-member").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("add-member-user-id").fill(userId);
  await dialog.getByRole("button", { name: "Add member" }).click();
}

/**
 * Drive the real Add member form at a User who does not exist, so the request the
 * Panel actually sends can be replayed by another principal. The Worker refuses
 * it (USER_NOT_FOUND) without writing a membership, which keeps the capture free
 * of side effects.
 */
async function captureAddRequest(page: Page, userId: string): Promise<Request> {
  await waitForHydration(page);
  const pending = page.waitForRequest(
    (request) => request.method() === "POST" && (request.postData() ?? "").includes(userId),
  );
  await addMember(page, userId);
  const captured = await pending;
  await expect(page.getByTestId("add-member-error")).toContainText(/user not found/i);
  return captured;
}

/**
 * The Panel posts server-function arguments as TanStack's serialized payload, so
 * the role travels as a nested `{"t":1,"s":"member"}` node rather than a plain
 * `"role":"member"` pair. Rewriting that node is the only way to send the body an
 * admin's own Select never offers, and a serialization drift fails here instead
 * of passing on an unmodified body.
 */
function forceOwnerRole(postData: string): string {
  const forced = postData.replace('{"t":1,"s":"member"}', '{"t":1,"s":"owner"}');
  expect(forced).not.toEqual(postData);
  return forced;
}

async function signedInPage(browser: import("@playwright/test").Browser, token: string) {
  // A manually created context does not inherit the project's `use` options.
  const context = await browser.newContext({ baseURL: origin });
  await context.addCookies([{ name: "__session", value: token, url: origin }]);
  return context.newPage();
}
