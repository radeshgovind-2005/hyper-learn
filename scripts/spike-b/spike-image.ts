// S4: Muse Image. Never prints the key.
import { writeFileSync } from "node:fs";
import { env } from "./env.js";
const key = env("MODEL_API_KEY");
const out = process.argv[2] ?? "/tmp/spike";
async function gen(body: Record<string, unknown>, label: string) {
  const t = Date.now();
  const res = await fetch("https://api.meta.ai/v1/images/generations", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const ms = Date.now() - t;
  let json: any; try { json = JSON.parse(text); } catch { console.log(label, res.status, ms, text.slice(0, 300)); return; }
  const d = json.data?.[0];
  console.log(label, res.status, `${ms}ms`, "keys:", Object.keys(json), "data0 keys:", d && Object.keys(d), "usage:", JSON.stringify(json.usage), json.error ? JSON.stringify(json.error).slice(0, 300) : "");
  if (d?.b64_json) { const buf = Buffer.from(d.b64_json, "base64"); writeFileSync(`${out}-${label}.bin`, buf); console.log("  bytes", buf.length, "magic", buf.subarray(0, 12).toString("hex")); }
  if (d?.url) console.log("  url", String(d.url).slice(0, 80));
}
const prompt = "Clean labelled educational diagram, white background, flat colours. UMA vs NUMA: left panel 'UMA' shows four CPUs sharing one memory bus to one memory; right panel 'NUMA' shows two nodes, each CPU with its own 'local memory', and a dashed 'remote access (slower)' arrow between nodes.";

await gen({ model: "muse-image-1.0", prompt, n: 1, output_format: "webp", output_compression: 50 }, "c50");
await gen({ model: "muse-image-1.0", prompt, n: 1, size: "1024x1024", output_format: "webp" }, "sq");
