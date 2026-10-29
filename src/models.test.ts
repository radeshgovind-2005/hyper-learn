import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { configureModels, defaultModels, ModelProvider, modelConfigFromEnv, refuseDefaultModels } from "./models.js";

const provider = (apiKey: string) => new ModelProvider({ ...modelConfigFromEnv({}), apiKey });

describe("ModelProvider", () => {
  it("keeps each course's key and models to itself", () => {
    const a = provider("key-a");
    const b = provider("key-b");
    assert.notEqual(a.chat("reasoning"), b.chat("reasoning"));
    assert.equal(a.chat("reasoning"), a.chat("reasoning"), "cached within one provider");
    assert.equal(a.chat("reasoning").apiKey, "key-a");
    assert.equal(b.chat("reasoning").apiKey, "key-b");
    assert.ok(!JSON.stringify(a).includes("key-a"), "the key isn't serialised with the provider");
    assert.ok(b.structured(z.object({ ok: z.boolean() }), "check"));
  });

  it("can refuse the process-wide default, as the Worker does", () => {
    refuseDefaultModels("no default here");
    assert.throws(() => defaultModels(), /no default here/);
    configureModels();
    assert.ok(defaultModels().chat("fast"));
  });
});
