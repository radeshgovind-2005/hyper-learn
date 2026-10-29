import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeysUnavailable, openSecret, sealSecret } from "./keys.js";

const SECRET = "test-only-secret-0123456789abcdefghijkl";

describe("sealing model keys", () => {
  it("opens what it sealed, in the same course", async () => {
    const sealed = await sealSecret("sk-meta-123", SECRET, "c-abcdefghijkl");
    assert.ok(!sealed.includes("sk-meta-123"));
    assert.equal(await openSecret(sealed, SECRET, "c-abcdefghijkl"), "sk-meta-123");
  });

  it("uses a fresh IV every time", async () => {
    const a = await sealSecret("same", SECRET, "c1");
    const b = await sealSecret("same", SECRET, "c1");
    assert.notEqual(a, b);
    assert.notEqual(a.split(".")[1], b.split(".")[1]);
  });

  it("can't be opened in another course, with another secret, or after any change", async () => {
    const sealed = await sealSecret("sk-meta-123", SECRET, "c-abcdefghijkl");
    await assert.rejects(openSecret(sealed, SECRET, "c-otherotherot"), /set it again/);
    await assert.rejects(openSecret(sealed, `${SECRET}x`, "c-abcdefghijkl"), /set it again/);
    const [format, iv, data] = sealed.split(".");
    const flipped = `${data!.slice(0, -2)}${data!.at(-2) === "A" ? "B" : "A"}${data!.at(-1)}`;
    await assert.rejects(openSecret([format, iv, flipped].join("."), SECRET, "c-abcdefghijkl"), /set it again/);
    await assert.rejects(openSecret("garbage", SECRET, "c-abcdefghijkl"), /Not a sealed key/);
  });

  it("refuses clearly without a long enough secret", async () => {
    await assert.rejects(sealSecret("k", undefined, "c1"), KeysUnavailable);
    await assert.rejects(sealSecret("k", "short", "c1"), /KEY_ENCRYPTION_SECRET/);
    await assert.rejects(openSecret("v1.a.b", "", "c1"), KeysUnavailable);
  });
});
