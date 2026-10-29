import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { EXEMPLARS } from "../interventions/exemplars.js";
import { compileCourse, compileSections, courseFromSnapshot, liveInterventions, renderLesson, splitBlocks } from "./compile.js";
import { loadCourse } from "./load.js";

// Compiled from the Markdown, not the bundle: these tests check the compiler and that the bundle matches.
const course = loadCourse();
const snapshot = compileCourse(course);
const lesson = (id: string) => snapshot.lessons.find((l) => l.id === id)!;

describe("compileSections", () => {
  it("splits a lesson into sections with stable block ids", () => {
    const sections = lesson("agent-loop").sections;
    assert.deepEqual(
      sections.map((s) => s.id),
      ["agent-loop/intro", "agent-loop/the-harness-does-the-acting", "agent-loop/observing-the-result", "agent-loop/stopping", "agent-loop/why-loops-are-powerful"],
    );
    assert.deepEqual(
      sections[0]!.blocks.map((b) => [b.id, b.kind]),
      [
        ["agent-loop/intro/p1", "paragraph"],
        ["agent-loop/intro/c1", "code"],
      ],
    );
  });

  it("keeps fenced code with blank lines in one block", () => {
    const blocks = splitBlocks("Text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n- one\n- two");
    assert.deepEqual(blocks.map((b) => b.kind), ["paragraph", "code", "list"]);
    assert.match(blocks[1]!.markdown, /const a = 1;\n\nconst b = 2;/);
  });

  it("disambiguates repeated headings", () => {
    const ids = compileSections("x", "# X\n\n## Notes\n\nA\n\n## Notes\n\nB").map((s) => s.id);
    assert.deepEqual(ids, ["x/notes", "x/notes-2"]);
  });
});

describe("renderLesson", () => {
  it("round-trips every lesson's Markdown", () => {
    const squash = (text: string) => text.replace(/\n{3,}/g, "\n\n").trim();
    for (const l of course.lessons) assert.equal(renderLesson(lesson(l.id)), squash(l.body), l.id);
  });

  it("leaves archived blocks and sections out", () => {
    const copy = structuredClone(lesson("agent-loop"));
    copy.sections[3]!.archived = true;
    copy.sections[0]!.blocks[1]!.archived = true;
    const text = renderLesson(copy);
    assert.doesNotMatch(text, /## Stopping/);
    assert.doesNotMatch(text, /decide → act/);
  });
});

describe("courseFromSnapshot", () => {
  it("rebuilds a valid course from the snapshot", () => {
    const rebuilt = courseFromSnapshot(snapshot);
    assert.deepEqual(rebuilt.graph, course.graph);
    assert.equal(rebuilt.misconceptions.length, course.misconceptions.length);
  });

  it("rejects an intervention block aimed at a misconception another lesson teaches", () => {
    const misplaced = structuredClone(snapshot);
    misplaced.lessons.find((l) => l.id === "tool-calling")!.sections[0]!.blocks.push({
      id: "tool-calling/intro/i1",
      kind: "intervention",
      archived: false,
      intervention: EXEMPLARS[0]!,
    });
    assert.throws(() => courseFromSnapshot(misplaced), /taught in "agent-loop", not "tool-calling"/);
  });

  it("keeps interventions out of the text every learner sees", () => {
    const withBlock = structuredClone(snapshot);
    withBlock.lessons.find((l) => l.id === "agent-loop")!.sections[1]!.blocks.push({
      id: "agent-loop/the-harness-does-the-acting/i1",
      kind: "intervention",
      archived: false,
      intervention: EXEMPLARS[0]!,
    });
    assert.equal(renderLesson(withBlock.lessons.find((l) => l.id === "agent-loop")!), renderLesson(lesson("agent-loop")));
    assert.equal(liveInterventions(withBlock).length, 1);
  });

  it("rejects a snapshot that breaks a course invariant", () => {
    const broken = structuredClone(snapshot);
    broken.lessons.find((l) => l.id === "llm-basics")!.prerequisites = ["reflection"];
    assert.throws(() => courseFromSnapshot(broken), /cycle/);
  });
});

describe("content/agentic-coding.bundle.json", () => {
  it("is up to date with the Markdown (run `npm run bundle`)", () => {
    const bundle = JSON.parse(readFileSync(new URL("../../content/agentic-coding.bundle.json", import.meta.url), "utf8"));
    assert.deepEqual(bundle, JSON.parse(JSON.stringify(snapshot)));
  });
});
