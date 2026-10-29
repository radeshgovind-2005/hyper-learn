import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccessDenied, can, requirePermission } from "../app/access.js";
import { IDENTITY_HEADERS, identityFrom, roleFrom, verifySessionToken, withIdentity } from "./identity.js";

// A stand-in for a Clerk instance: an RS256 key pair, its public key in PEM (what Clerk calls the JWT
// public key), and session tokens signed with it.
const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
const jwtKey = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)!.join("\n")}\n-----END PUBLIC KEY-----`;
const SITE = "https://hyperlearn.radesh-govind.com";
const options = { jwtKey, authorizedParties: [SITE] };

const b64url = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");
async function token(claims: Record<string, unknown>, privateKey: CryptoKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test" }));
  const payload = b64url(JSON.stringify({ sub: "user_ada", azp: SITE, iat: now, nbf: now - 5, exp: now + 60, sid: "sess_1", ...claims }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

describe("verifySessionToken", () => {
  it("accepts a valid token and reads the role claim", async () => {
    assert.deepEqual(await verifySessionToken(await token({ role: "instructor" }), options), { userId: "user_ada", role: "instructor" });
  });

  it("treats a missing or unknown role as learner", async () => {
    assert.equal((await verifySessionToken(await token({}), options))?.role, "learner");
    assert.equal((await verifySessionToken(await token({ role: "superuser" }), options))?.role, "learner");
  });

  it("rejects expired tokens, tokens for another site, and tokens signed with another key", async () => {
    const now = Math.floor(Date.now() / 1000);
    assert.equal(await verifySessionToken(await token({ exp: now - 120, nbf: now - 300, iat: now - 300 }), options), null);
    assert.equal(await verifySessionToken(await token({ azp: "https://evil.example" }), options), null);
    const other = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    assert.equal(await verifySessionToken(await token({}, other.privateKey), options), null);
    assert.equal(await verifySessionToken("not-a-token", options), null);
    assert.equal(await verifySessionToken("", options), null);
  });
});

describe("forwarding identity", () => {
  it("strips identity headers a client sent, and sets the verified ones", () => {
    const spoofed = new Request(SITE, { headers: { [IDENTITY_HEADERS.user]: "user_mallory", [IDENTITY_HEADERS.role]: "admin" } });
    assert.equal(identityFrom(withIdentity(spoofed, null)), null);
    assert.deepEqual(identityFrom(withIdentity(spoofed, { userId: "user_ada", role: "learner" })), { userId: "user_ada", role: "learner" });
  });

  it("reads a forwarded role defensively", () => {
    assert.equal(roleFrom("admin"), "admin");
    assert.equal(roleFrom(undefined), "learner");
  });
});

describe("access", () => {
  const matrix = {
    learner: { learn: true, repair: false, view_learners: false, reset: false, manage_roles: false },
    instructor: { learn: true, repair: true, view_learners: true, reset: false, manage_roles: false },
    admin: { learn: true, repair: true, view_learners: true, reset: true, manage_roles: true },
  } as const;

  it("matches the permission table, cell by cell", () => {
    for (const [role, grants] of Object.entries(matrix)) {
      for (const [permission, allowed] of Object.entries(grants)) {
        assert.equal(can(role as keyof typeof matrix, permission as keyof typeof grants), allowed, `${role} ${permission}`);
      }
    }
  });

  it("refuses with a message for people, not a stack trace", () => {
    assert.throws(() => requirePermission(null, "learn"), (e) => e instanceof AccessDenied && /Sign in/.test(e.message));
    assert.throws(() => requirePermission({ userId: "u", role: "learner" }, "repair"), /Your role \(learner\) can't do that/);
    assert.deepEqual(requirePermission({ userId: "u", role: "admin" }, "reset"), { userId: "u", role: "admin" });
  });
});
