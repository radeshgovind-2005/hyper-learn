// Stream A spike (A1): can Meta's API read our pages? Not shipped, not tested; run by hand:
//   SPIKE_DIR=<dir with p15.pdf and p15.png> npx tsx scripts/spike-a.ts
// Reads MODEL_BASE_URL and MODEL_API_KEY from .env (or the environment). Never prints the key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ModelProvider, modelConfigFromEnv } from "../src/models.js";
import { HumanMessage } from "@langchain/core/messages";

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z_]+)=([^#\s]*)/.exec(line);
  if (m) env[m[1]!] = m[2]!;
}
const base = (process.env.MODEL_BASE_URL ?? env.MODEL_BASE_URL)!.replace(/\/$/, "");
const key = (process.env.MODEL_API_KEY ?? env.MODEL_API_KEY)!;
const dir = process.env.SPIKE_DIR!;
const pdf = readFileSync(join(dir, "p15.pdf")).toString("base64");
const png = readFileSync(join(dir, "p15.png")).toString("base64");
const only = process.argv[2];

async function post(path: string, body: unknown) {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await res.text();
  return { status: res.status, ms: Math.round(performance.now() - t), text };
}

const ASK = "List every figure, table and chart on this page. For each: kind, a caption, and for tables the full table as Markdown with every row and value.";

if (!only || only === "s1") {
  const r = await post("/chat/completions", {
    model: "muse-spark-1.3",
    messages: [{ role: "user", content: [{ type: "text", text: ASK }, { type: "file", file: { filename: "p15.pdf", file_data: `data:application/pdf;base64,${pdf}` } }] }],
  });
  console.log("S1 file part", r.status, `${r.ms} ms`, r.text.slice(0, 3000));
}

const FigureSchema = z.object({
  figures: z.array(
    z.object({
      kind: z.enum(["figure", "table", "chart", "equation"]),
      caption: z.string(),
      table_markdown: z.string().nullable(),
      latex: z.string().nullable(),
      teaches: z.string(),
    }),
  ),
});

if (!only || only === "s2") {
  const r = await post("/chat/completions", {
    model: "muse-spark-1.3",
    messages: [{ role: "user", content: [{ type: "text", text: ASK }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }],
    response_format: { type: "json_schema", json_schema: { name: "page_figures", strict: true, schema: z.toJSONSchema(FigureSchema) } },
  });
  console.log("S2 raw image + json_schema", r.status, `${r.ms} ms`, r.text.slice(0, 3000));

  const provider = new ModelProvider({ ...modelConfigFromEnv({ ...env, REASONING_MODEL: "muse-spark-1.3" }), apiKey: key, baseURL: base });
  const t = performance.now();
  try {
    const out = await provider
      .structured(FigureSchema, "page_figures")
      .invoke([new HumanMessage({ content: [{ type: "text", text: ASK }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] })]);
    console.log("S2 ModelProvider.structured", `${Math.round(performance.now() - t)} ms`, JSON.stringify(out).slice(0, 2000));
  } catch (e) {
    console.log("S2 ModelProvider.structured failed", e instanceof Error ? e.message.slice(0, 500) : e);
  }
}

if (!only || only === "s3") {
  for (const prompt of ["table", "figure", "chart"]) {
    const r = await post("/responses", {
      model: "sam-3.1",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_image", image_url: `data:image/png;base64,${png}` }] }],
    });
    console.log(`S3 sam "${prompt}"`, r.status, `${r.ms} ms`, r.text.replace(/data=[^|]{60,}/g, (d) => `${d.slice(0, 40)}…[${d.length}]`).slice(0, 2500));
  }
}
