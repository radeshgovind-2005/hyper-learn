import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRoleChange, setClerkRole } from "./roles.js";

describe("role changes", () => {
  it("accepts a known role for someone else", () => {
    assert.equal(checkRoleChange("user_admin", "user_abc123", "instructor"), "instructor");
  });

  it("refuses unknown roles, malformed ids, and changing one's own role", () => {
    assert.throws(() => checkRoleChange("user_admin", "user_abc123", "owner"), /Unknown role/);
    assert.throws(() => checkRoleChange("user_admin", "../users", "admin"), /Clerk user id/);
    assert.throws(() => checkRoleChange("user_admin", "user_admin", "learner"), /your own role/);
  });

  it("writes the role to the user's public metadata in Clerk", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await setClerkRole("sk_test_x", "user_abc123", "instructor", fake);
    assert.equal(calls[0]?.url, "https://api.clerk.com/v1/users/user_abc123/metadata");
    assert.equal(calls[0]?.init.method, "PATCH");
    assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer sk_test_x");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { public_metadata: { role: "instructor" } });
  });

  it("reports a missing user, and other failures without echoing Clerk's body", async () => {
    const status = (code: number) => (async () => new Response("secret-ish detail", { status: code })) as unknown as typeof fetch;
    await assert.rejects(setClerkRole("sk", "user_x", "admin", status(404)), /No such user/);
    await assert.rejects(setClerkRole("sk", "user_x", "admin", status(500)), (e: Error) => /\(500\)/.test(e.message) && !e.message.includes("secret-ish"));
  });
});
