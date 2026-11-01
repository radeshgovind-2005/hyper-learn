import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { segment } from "./sam.js";
import { readPage } from "./vision.js";

// Spark vision and SAM against a replaced network: the requests carry the image and the key in the
// header only, and the answers are parsed and checked.

const config = { baseURL: "https://api.example.com/v1/", apiKey: "sk-test", model: "muse-spark-1.3", retries: 0 };
const image = { mime: "image/jpeg" as const, base64: "/9j/AAAA" };
const realFetch = globalThis.fetch;
let requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  requests = [];
});

describe("readPage (Spark vision)", () => {
  it("sends the picture with a strict schema and returns at most four figures", async () => {
    const figure = { kind: "table", caption: "Levels", box: { x1: 0, y1: 0, x2: 1, y2: 1 }, sam_prompt: "table", table_markdown: "| a |\n|---|\n| 1 |", latex: null, teaches: "x" };
    answer(200, { choices: [{ message: { content: JSON.stringify({ figures: Array.from({ length: 6 }, () => figure) }) } }] });
    const figures = await readPage(config, image);
    assert.equal(figures.length, 4);
    const [req] = requests;
    assert.equal(req!.url, "https://api.example.com/v1/chat/completions");
    assert.equal(req!.headers.get("authorization"), "Bearer sk-test");
    assert.ok(!JSON.stringify(req!.body).includes("sk-test"), "the key is only in the header");
    assert.equal((req!.body.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
    assert.match(JSON.stringify(req!.body.messages), /data:image\/jpeg;base64,\/9j\/AAAA/);
  });

  it("throws on an HTTP error or output that doesn't fit the schema", async () => {
    answer(429, { error: "slow down" });
    await assert.rejects(readPage(config, image), /HTTP 429/);
    answer(200, { choices: [{ message: { content: JSON.stringify({ figures: [{ kind: "poster" }] }) } }] });
    await assert.rejects(readPage(config, image));
  });
});

describe("segment (SAM 3.1)", () => {
  it("asks the Responses API and parses the boxes", async () => {
    answer(200, { output: [{ type: "message", content: [{ type: "output_text", text: "<|box;x1=333;y1=230;x2=833;y2=545;w=1200;h=676|><|mask;x=0;y=0;data=9,9,xyz|>" }] }] });
    const boxes = await segment(config, image, "chart");
    assert.equal(boxes.length, 1);
    assert.equal(requests[0]!.url, "https://api.example.com/v1/responses");
    assert.equal(requests[0]!.body.model, "sam-3.1");
  });

  it("returns no boxes for an empty answer, and throws on an HTTP error", async () => {
    answer(200, { output: [{ type: "message", content: [{ type: "output_text", text: "" }] }] });
    assert.deepEqual(await segment(config, image, "figure"), []);
    answer(500, {});
    await assert.rejects(segment(config, image, "chart"), /HTTP 500/);
  });
});
