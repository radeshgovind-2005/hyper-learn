import { ROLES, type Role } from "./identity.js";

// Changing someone's role. Roles live in Clerk (the user's public metadata, copied into their session
// token as the `role` claim), so a change is written there; it reaches the app the next time that
// person's browser fetches a token and reconnects (within about a minute, or on reload).

const CLERK_API = "https://api.clerk.com/v1";

export class RoleChangeRefused extends Error {}

/** Checks a role change before anything is written. Admins can't change their own role, so the last admin can't lock everyone out. */
export function checkRoleChange(by: string, userId: string, role: unknown): Role {
  if (typeof userId !== "string" || !/^user_[A-Za-z0-9]+$/.test(userId)) throw new RoleChangeRefused("That isn't a Clerk user id");
  if (!(ROLES as readonly unknown[]).includes(role)) throw new RoleChangeRefused(`Unknown role "${String(role)}"`);
  if (userId === by) throw new RoleChangeRefused("You can't change your own role; ask another admin");
  return role as Role;
}

/** Sets a user's role in Clerk (merged into their public metadata; other keys are kept). Needs the instance's secret key. */
export async function setClerkRole(secretKey: string, userId: string, role: Role, fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher(`${CLERK_API}/users/${encodeURIComponent(userId)}/metadata`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify({ public_metadata: { role } }),
  });
  if (response.ok) return;
  if (response.status === 404) throw new RoleChangeRefused("No such user in Clerk");
  // Clerk's error body is for logs, not for people; it never includes the key.
  console.error(`Clerk role update failed (${response.status}):`, await response.text().catch(() => ""));
  throw new Error(`Clerk refused the role change (${response.status})`);
}
