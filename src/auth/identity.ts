import { verifyToken } from "@clerk/backend";

// Who is making a request. Clerk signs a short-lived session token in the browser; the Worker verifies
// it here (networkless, with the instance's public key) before anything reaches the Durable Object, then
// forwards the result as headers it controls. Runs in Node and in Workers.

export const ROLES = ["learner", "instructor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export interface Identity {
  userId: string;
  role: Role;
  /** Display name and email, when the Clerk session token carries them (optional claims `name`, `email`). */
  name?: string;
  email?: string;
}

const optionalText = (value: unknown, max = 200) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

/** The role claim from the session token. Missing or unknown = learner: no one gains access by accident. */
export function roleFrom(claim: unknown): Role {
  return typeof claim === "string" && (ROLES as readonly string[]).includes(claim) ? (claim as Role) : "learner";
}

export interface VerifyOptions {
  /** The Clerk instance's JWT public key (PEM), for verification without a network call. */
  jwtKey: string;
  /** Origins allowed to have issued the token (its `azp` claim), e.g. the site's own URL. */
  authorizedParties: string[];
}

/** Verifies a Clerk session token. Returns null for anything invalid, expired or issued for another site. */
export async function verifySessionToken(token: string, { jwtKey, authorizedParties }: VerifyOptions): Promise<Identity | null> {
  if (!token) return null;
  try {
    const claims = await verifyToken(token, { jwtKey, authorizedParties });
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    const extra = claims as Record<string, unknown>;
    const name = optionalText(extra.name);
    const email = optionalText(extra.email);
    return { userId: claims.sub, role: roleFrom(extra.role), ...(name && { name }), ...(email && { email }) };
  } catch {
    return null;
  }
}

/** Headers the Worker sets after verifying a token. Never trusted from the client: always stripped first. */
export const IDENTITY_HEADERS = { user: "x-hl-user", role: "x-hl-role", name: "x-hl-name", email: "x-hl-email" } as const;

/** The request with any client-sent identity headers removed, and the verified identity set (if any). */
export function withIdentity(request: Request, identity: Identity | null): Request {
  const headers = new Headers(request.headers);
  for (const header of Object.values(IDENTITY_HEADERS)) headers.delete(header);
  if (identity) {
    headers.set(IDENTITY_HEADERS.user, identity.userId);
    headers.set(IDENTITY_HEADERS.role, identity.role);
    // Names can hold any characters; headers can't, so they travel URI-encoded.
    if (identity.name) headers.set(IDENTITY_HEADERS.name, encodeURIComponent(identity.name));
    if (identity.email) headers.set(IDENTITY_HEADERS.email, encodeURIComponent(identity.email));
  }
  return new Request(request, { headers });
}

/** The identity the Worker forwarded, read inside the Durable Object. */
export function identityFrom(request: Request): Identity | null {
  const userId = request.headers.get(IDENTITY_HEADERS.user);
  if (!userId) return null;
  const decoded = (header: string) => {
    const value = request.headers.get(header);
    try {
      return value ? decodeURIComponent(value) : undefined;
    } catch {
      return undefined;
    }
  };
  const name = decoded(IDENTITY_HEADERS.name);
  const email = decoded(IDENTITY_HEADERS.email);
  return { userId, role: roleFrom(request.headers.get(IDENTITY_HEADERS.role)), ...(name && { name }), ...(email && { email }) };
}
