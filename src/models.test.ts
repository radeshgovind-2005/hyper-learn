import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  configureModels,
  defaultModels,
  ModelProvider,
  modelChoicesFromEnv,
  modelConfigFromEnv,
  modelEndpointsFromEnv,
  OPEN_WEIGHTS_DEFAULT_MODEL,
  openWeightsConfigFromEnv,
  refuseDefaultModels,
} from "./models.js";

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

describe("open weights (Muse Spark Open on Baseten)", () => {
  it("is offered, with its own endpoint, only when the Worker configures one", () => {
    assert.deepEqual(modelChoicesFromEnv({ REASONING_MODEL: "muse-spark-1.3" }), ["muse-spark-1.3"]);
    assert.deepEqual(modelEndpointsFromEnv({}), {});
    const env = { MODEL_CHOICES: "muse-spark-1.3", OPEN_WEIGHTS_BASE_URL: "https://model-x.api.baseten.co/v1" };
    assert.deepEqual(modelChoicesFromEnv(env), ["muse-spark-1.3", OPEN_WEIGHTS_DEFAULT_MODEL]);
    assert.deepEqual(modelEndpointsFromEnv(env), { [OPEN_WEIGHTS_DEFAULT_MODEL]: "https://model-x.api.baseten.co/v1" });
    assert.equal(openWeightsConfigFromEnv(env), null, "no key, no Node config");
    assert.equal(openWeightsConfigFromEnv({ ...env, OPEN_WEIGHTS_API_KEY: "k" })!.models.reasoning, OPEN_WEIGHTS_DEFAULT_MODEL);
  });

  it("swaps the model and keeps the endpoint and key for the verifier", () => {
    const provider = new ModelProvider({ ...modelConfigFromEnv({ MODEL_BASE_URL: "https://api.example.com/v1" }), apiKey: "k" });
    assert.equal(provider.withModel("muse-wonder-1.0").models.reasoning, "muse-wonder-1.0");
  });
});
