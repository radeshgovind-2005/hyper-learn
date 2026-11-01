// B8: the independent verifier (muse-wonder-1.0) on one supported and one wrong personal block. Never prints the key.
import { ModelProvider, modelConfigFromEnv } from "../../src/models.js";
import { wonderVerifier } from "../../src/tutor/verify.js";
import { env } from "./env.js";
const provider = new ModelProvider({ ...modelConfigFromEnv({ MODEL_BASE_URL: "https://api.meta.ai/v1", STRUCTURED_OUTPUT_METHOD: "jsonSchema" }), apiKey: env("MODEL_API_KEY"), models: { reasoning: "muse-spark-1.3", fast: "muse-spark-1.3" } });
const sources = [{ id: "s1", name: "numa-notes.pdf", pages: ["In NUMA, local access is fast; remote access is slower, typically 1.5 to 2 times the latency of a local access, because the request and data travel over the interconnect and through the other node's controller."] }];
for (const [label, text] of [["supported", "Remote access takes about 1.5 to 2 times as long as local access, because it crosses the interconnect."], ["wrong", "Remote access is 10 times slower because the remote node's processors must be idle before they can serve the request."]] as const) {
  const t0 = Date.now();
  try {
    const verdict = await wonderVerifier(provider, { sources, pieces: [{ kind: "text", markdown: text, cites: [{ source: "s1", page: 1 }] }] });
    console.log(label, `${Date.now() - t0} ms`, JSON.stringify(verdict).slice(0, 300));
  } catch (error) {
    console.log(label, "FAILED", error instanceof Error ? error.message.slice(0, 300) : error);
  }
}
