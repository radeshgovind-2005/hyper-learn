import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTextBlock } from "../course/compile.js";
import type { PageImage } from "../media/contracts.js";
import type { FigureRead } from "../meta/vision.js";
import { parseBoxes } from "../meta/sam.js";
import { buildCourse } from "./build.js";
import { INPUT, spiedModels, totalCalls } from "./fixtures.test-helpers.js";
import { chooseBox, cleanBox, iou, type PageSeer } from "./see.js";
import type { BuildResult } from "./types.js";

// The "see" step on scripted vision and SAM: figures get ids from code, the writer may show only those on
// its section's pages, tables reach the writer as Markdown, and a failed vision call leaves the build text-only.

const IMAGE: PageImage = { mime: "image/jpeg", base64: "/9j/AAAA" };
const TABLE = "| Season | Notch spacing |\n|---|---|\n| Summer | 1 cm |\n| Winter | 1.4 cm |";

const reads: Record<number, FigureRead[]> = {
  1: [{ kind: "table", caption: "Notch spacing by season", box: { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.6 }, sam_prompt: "table", table_markdown: TABLE, latex: null, teaches: "Winter notches are wider." }],
  2: [{ kind: "chart", caption: "Growth per day", box: { x1: 0.3, y1: 0.3, x2: 0.8, y2: 0.9 }, sam_prompt: "chart", table_markdown: null, latex: null, teaches: "Growth slows in the cold." }],
};

/** A seer over two notes pages and one exam page; read() answers per page, in order of the calls. */
function pagedSeer(failOn?: number): PageSeer & { segments: string[] } {
  const segments: string[] = [];
  let call = 0;
  return {
    segments,
    pages: [
      { source: "s1", page: 1 },
      { source: "s1", page: 2 },
      { source: "s2", page: 1 }, // the exam: never read, it isn't teaching material
    ],
    image: async () => IMAGE,
    read: async () => {
      const page = [1, 2][call++]!;
      if (page === failOn) throw new Error("HTTP 429: quota");
      return reads[page]!;
    },
    segment: async (_image, prompt) => {
      segments.push(prompt);
      return prompt === "chart" ? [{ x1: 0.32, y1: 0.28, x2: 0.82, y2: 0.88 }] : [];
    },
  };
}

/** The writer adds the first figure its prompt offers; with `missing`, its first draft names one that doesn't exist. */
function figureWriter(missing = false) {
  let wrong = missing;
  return spiedModels({
    writer: (prompt, answer) => {
      const offered = /^- fig:(\S+) /m.exec(prompt)?.[1];
      const page = /<source id="(s\d+)" page="(\d+)">/.exec(prompt)!;
      if (!offered) return answer;
      const id = wrong ? "s1/p9/f1" : offered;
      if (wrong && !prompt.includes("REJECTED")) wrong = false;
      else if (wrong) return answer;
      return { ...answer, blocks: [...answer.blocks, { markdown: `![Notch spacing](fig:${id})`, cites: [{ source: page[1]!, page: Number(page[2]), quote: null }] }] };
    },
  });
}

const figureRefs = (result: BuildResult) =>
  result.ok
    ? result.snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks.filter(isTextBlock).flatMap((b) => [...b.markdown.matchAll(/\(fig:([^)]+)\)/g)].map((m) => m[1]!))))
    : [];

describe("the see step", () => {
  it("finds figures with ids from code, refines boxes with SAM, and counts every call", async () => {
    const models = figureWriter();
    const s = pagedSeer();
    const result = await buildCourse(INPUT, models, { seer: s, stress: false, concurrency: 1 });
    assert.ok(result.ok, result.ok ? "" : result.problems.join("\n"));
    assert.deepEqual(result.figures?.map((f) => f.id), ["s1/p1/f1", "s1/p2/f1"]);
    const chart = result.figures!.find((f) => f.kind === "chart")!;
    // SAM's box overlaps vision's, so the crop is their union, with a margin.
    assert.ok(chart.box.y1 < 0.28 && chart.box.x2 > 0.82, JSON.stringify(chart.box));
    assert.equal(result.figures![0]!.table_markdown, TABLE);
    assert.deepEqual(s.segments, ["table", "chart"]);
    const see = result.report.steps.find((step) => step.stage === "see")!;
    assert.match(see.title, /2 page picture\(s\): 2 figure\(s\)/);
    assert.match(see.detail!, /2 vision call\(s\) \(Muse Spark\), 2 segmentation call\(s\) \(SAM 3\.1\)/);
    assert.equal(result.report.model_calls, totalCalls(models) + 4, "vision and SAM calls count against the build's budget");
  });

  it("shows the writer the figures on its pages, and tables as Markdown; lessons use only real ids", async () => {
    const models = figureWriter();
    const result = await buildCourse(INPUT, models, { seer: pagedSeer(), stress: false, concurrency: 1 });
    const page1 = models.writer.prompts.find((p) => p.includes('<source id="s1" page="1">'))!;
    assert.match(page1, /- fig:s1\/p1\/f1 \(table, s1 p\.1\): Notch spacing by season/);
    assert.ok(page1.includes(TABLE), "the table, as vision read it, is in the page text");
    const refs = figureRefs(result);
    assert.ok(refs.length > 0, "a lesson shows a figure");
    for (const ref of refs) assert.ok(result.ok && result.figures!.some((f) => f.id === ref), `${ref} resolves`);
  });

  it("sends a draft that shows a figure not on its pages back to the writer", async () => {
    const models = figureWriter(true);
    const result = await buildCourse(INPUT, models, { seer: pagedSeer(), stress: false, concurrency: 1 });
    assert.ok(result.ok);
    const rejected = result.report.steps.find((s) => s.stage === "write" && s.status === "rejected")!;
    assert.match(rejected.detail!, /shows fig:s1\/p9\/f1, which is not a figure on this section's pages \(you may use: fig:s1\/p1\/f1\)/);
    assert.ok(models.writer.prompts.some((p) => p.includes("REJECTED") && p.includes("fig:s1/p9/f1")));
    assert.ok(!figureRefs(result).includes("s1/p9/f1"));
  });

  it("keeps building, text only for that page, when a vision call fails", async () => {
    const result = await buildCourse(INPUT, figureWriter(), { seer: pagedSeer(2), stress: false, concurrency: 1 });
    assert.ok(result.ok);
    assert.deepEqual(result.figures?.map((f) => f.id), ["s1/p1/f1"]);
    assert.ok(result.report.warnings.some((w) => /1 page picture\(s\) couldn't be read/.test(w)));
    assert.match(result.report.steps.find((s) => s.stage === "see")!.detail!, /Not read: s1 p\.2: HTTP 429/);
  });

  it("makes no vision call without page pictures", async () => {
    const result = await buildCourse(INPUT, spiedModels(), { stress: false, concurrency: 1 });
    assert.ok(result.ok && !result.figures);
    assert.ok(!result.report.steps.some((s) => s.stage === "see"));
  });
});

describe("boxes", () => {
  it("parses SAM's box tokens into fractions of the image", () => {
    const text = "<|box;x1=333;y1=230;x2=833;y2=545;w=1200;h=676|><|mask;x=0;y=0;data=1,2,abc|>,1<|box;x1=10;y1=5;x2=5;y2=9;w=100;h=100|>";
    const [box, ...rest] = parseBoxes(text);
    assert.equal(rest.length, 0, "a box with x2 < x1 is skipped");
    assert.ok(Math.abs(box!.x1 - 333 / 1200) < 1e-9 && Math.abs(box!.y2 - 545 / 676) < 1e-9);
    assert.deepEqual(parseBoxes(""), []);
  });

  it("joins vision's box with the SAM box that overlaps it, and ignores one about something else", () => {
    const vision = { x1: 0.235, y1: 0.285, x2: 0.86, y2: 0.93 };
    const plot = { x1: 0.2775, y1: 0.34, x2: 0.694, y2: 0.806 };
    assert.ok(iou(vision, plot) > 0.3);
    const near = (a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a) => (["x1", "y1", "x2", "y2"] as const).every((k) => Math.abs(a[k] - b[k]) < 1e-9);
    // The plot sits inside vision's box (which has the title and legend): the union is vision's box, plus a margin.
    assert.ok(near(chooseBox(vision, [{ x1: 0, y1: 0, x2: 0.1, y2: 0.1 }, plot]), { x1: 0.225, y1: 0.275, x2: 0.87, y2: 0.94 }));
    // A SAM box that reaches further out widens the crop.
    assert.ok(near(chooseBox(vision, [{ ...plot, x1: 0.2 }]), { x1: 0.19, y1: 0.275, x2: 0.87, y2: 0.94 }));
    assert.ok(near(chooseBox(vision, [{ x1: 0, y1: 0, x2: 0.1, y2: 0.1 }]), { x1: 0.225, y1: 0.275, x2: 0.87, y2: 0.94 }));
  });

  it("orders, clamps and repairs vision's box", () => {
    assert.deepEqual(cleanBox({ x1: 0.9, y1: 1.4, x2: 0.1, y2: -0.2 }), { x1: 0.1, y1: 0, x2: 0.9, y2: 1 });
    assert.deepEqual(cleanBox({ x1: 0.5, y1: 0.5, x2: 0.505, y2: 0.9 }), { x1: 0, y1: 0, x2: 1, y2: 1 });
    assert.deepEqual(cleanBox(null), { x1: 0, y1: 0, x2: 1, y2: 1 });
    assert.deepEqual(cleanBox({ x1: Number.NaN, y1: 0.1, x2: 0.5, y2: 0.6 }), { x1: 0, y1: 0.1, x2: 0.5, y2: 0.6 });
  });
});

describe("provenance", () => {
  const blocks = (result: BuildResult) => (result.ok ? result.snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks.filter(isTextBlock))) : []);

  it("gives every built text block its pages and the fact check's verdict", async () => {
    const result = await buildCourse(INPUT, spiedModels(), { stress: false, concurrency: 1 });
    const all = blocks(result);
    assert.ok(all.length > 0);
    for (const b of all) {
      assert.deepEqual(b.provenance?.pages, b.cites);
      assert.equal(b.provenance?.fact_check, "supported");
    }
  });

  it("marks a section the fact check still doubts after its rewrite, and one never checked", async () => {
    let first = true;
    const doubting = spiedModels({ fact_checker: (prompt, answer) => (prompt.includes("Pruning") ? { supported: false, unsupported: ["Pruning stops time."] } : first ? ((first = false), answer) : answer) });
    const result = await buildCourse(INPUT, doubting, { stress: false, concurrency: 1 });
    const verdicts = new Set(blocks(result).map((b) => b.provenance?.fact_check));
    assert.ok(verdicts.has("doubted") && verdicts.has("supported"), [...verdicts].join());
    const unchecked = await buildCourse(INPUT, spiedModels(), { stress: false, review: false, concurrency: 1 });
    assert.ok(blocks(unchecked).every((b) => b.provenance?.fact_check === "unchecked"));
  });
});

describe("quotes (A10)", () => {
  it("keeps a quote found on its page and drops one that isn't, without rejecting the block", async () => {
    const { sectionFromDraft, findQuote } = await import("./write.js");
    const section = { id: "l/s", title: "S", pages: [{ source: "s1", page: 1 }] };
    const sources = [{ id: "s1", name: "n", role: "material" as const, pages: ["A bramble clock measures time by the growth of a trained bramble stem."] }];
    const draft = (quote: string | null) => ({
      blocks: [{ markdown: "Bramble clocks grow.", cites: [{ source: "s1", page: 1, quote }] }],
      check: { prompt: "Which?", options: [{ text: "A", correct: true, feedback: "Yes" }, { text: "B", correct: false, feedback: "No" }] },
    });
    const kept = sectionFromDraft(draft("measures time by the GROWTH of a trained"), section, [], sources);
    assert.deepEqual(kept.section!.blocks[0]!.quotes, [{ source: "s1", page: 1, text: "measures time by the GROWTH of a trained" }]);
    const dropped = sectionFromDraft(draft("measures time by the shadow of a sundial"), section, [], sources);
    assert.equal(dropped.problems.length, 0);
    assert.equal(dropped.section!.blocks[0]!.quotes, undefined);
    assert.equal(dropped.dropped_quotes, 1);
    assert.deepEqual(findQuote("one two\nthree-four five", "two three four"), [4, 18]);
  });

  it("built blocks carry the quotes the build checked", async () => {
    const result = await buildCourse(INPUT, spiedModels(), { stress: false, concurrency: 1 });
    assert.ok(result.ok);
    const blocks = result.snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks.filter(isTextBlock)));
    assert.ok(blocks.every((b) => (b.quotes ?? []).length > 0), "the canned writer quotes every page");
  });
});
