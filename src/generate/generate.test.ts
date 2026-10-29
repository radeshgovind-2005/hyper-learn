import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CourseSnapshot, courseFromSnapshot, isTextBlock } from "../course/compile.js";
import { buildCourse, MAX_FIX_ROUNDS } from "./build.js";
import { assessmentSentences, copiedSentence, studioChecks } from "./checks.js";
import { EXAM, INPUT, NOTES, spiedModels, totalCalls } from "./fixtures.test-helpers.js";
import type { PlannedSection } from "./plan.js";
import { fitParts, thinLines } from "./prompt.js";
import { roleFromName } from "./sources.js";
import { stressTest } from "./stress.js";
import type { BuildResult } from "./types.js";
import { sanitizeMarkdown, sectionFromDraft } from "./write.js";

const built = (result: BuildResult): CourseSnapshot => {
  assert.ok(result.ok, `build failed:\n${result.ok ? "" : result.problems.join("\n")}`);
  return result.snapshot;
};
const stages = (result: BuildResult, stage: string) => result.report.steps.filter((s) => s.stage === stage);

describe("buildCourse (end to end, canned models)", async () => {
  const models = spiedModels();
  const result = await buildCourse(INPUT, models);
  const snapshot = built(result);

  it("builds a snapshot that passes courseFromSnapshot and the studio checks", () => {
    assert.equal(snapshot.version, "1.0.0");
    assert.equal(snapshot.course_id, "bramble-clocks");
    assert.doesNotThrow(() => courseFromSnapshot(snapshot));
    assert.deepEqual(studioChecks(snapshot, [{ ...NOTES, role: "material" }, { ...EXAM, role: "assessment" }]), []);
  });

  it("plans 3 lessons in prerequisite order, with objectives, exam pools and section checks", () => {
    assert.equal(snapshot.lessons.length, 3);
    assert.deepEqual(snapshot.lessons[0]!.prerequisites, []);
    assert.deepEqual(snapshot.lessons[2]!.prerequisites, [snapshot.lessons[1]!.id]);
    for (const lesson of snapshot.lessons) {
      assert.deepEqual(lesson.exam, { per_objective: 1 });
      const objectives = snapshot.objectives!.filter((o) => o.lesson === lesson.id);
      assert.ok(objectives.length >= 2);
      for (const o of objectives) assert.ok(lesson.quiz.filter((item) => item.objective === o.id).length >= 3);
      for (const section of lesson.sections) {
        const checks = section.blocks.filter((b) => b.kind === "check");
        assert.equal(checks.length, 1);
        assert.ok(section.blocks.filter(isTextBlock).every((b) => (b.cites ?? []).length > 0));
      }
      assert.ok(lesson.quiz.every((item) => ["single_choice", "multi_select", "two_tier", "ordering"].includes(item.type)));
    }
  });

  it("assigns every id in code", () => {
    const ids = [
      ...snapshot.lessons.map((l) => l.id),
      ...snapshot.lessons.flatMap((l) => l.quiz.map((item) => item.id)),
      ...snapshot.misconceptions.map((m) => m.id),
      ...snapshot.objectives!.map((o) => o.id),
    ];
    assert.equal(new Set(ids).size, ids.length);
    for (const lesson of snapshot.lessons) {
      for (const section of lesson.sections) {
        assert.ok(section.id.startsWith(`${lesson.id}/`));
        for (const block of section.blocks) assert.match(block.id, new RegExp(`^${section.id}/[plck]\\d+$`));
      }
    }
  });

  it("classifies by file name without a model call, and counts every call", () => {
    assert.equal(models.classifier.prompts.length, 0);
    assert.equal(result.report.model_calls, totalCalls(models));
    // 2 digests + plan + 6 sections + 3 lessons + 6 fact checks
    assert.equal(result.report.model_calls, 18);
  });

  it("keeps every call within maxChars", () => {
    for (const model of Object.values(models)) for (const size of model.sizes) assert.ok(size <= 24_000);
  });

  it("shows the writer only its section's pages", () => {
    for (const prompt of models.writer.prompts) {
      const shown = [...prompt.matchAll(/<source id="(\S+)" page="(\d+)">/g)].map((m) => `${m[1]} p.${m[2]}`);
      const allowed = /Cite only these pages: (.+)\./.exec(prompt)![1]!.split(", ");
      assert.deepEqual(shown, allowed);
      assert.ok(!prompt.includes(EXAM.pages[0]!.slice(0, 40)), "the exam text never reaches the writer");
    }
  });

  it("reports progress for every stage and detects a removed prerequisite in the stress test", () => {
    for (const stage of ["classify", "digest", "plan", "write", "assess", "validate", "review", "stress", "done"]) {
      assert.ok(stages(result, stage).length > 0, `no ${stage} step`);
    }
    const stress = stages(result, "stress")[0]!;
    assert.equal(stress.status, "ok");
    assert.match(stress.title, /detected/);
    assert.deepEqual(result.report.warnings, []);
  });
});

describe("validate → fix rounds", () => {
  it("sends a failing assessment back to the examiner, which repairs it", async () => {
    let broken = 0;
    const models = spiedModels({
      // The first draft for the second lesson forgets its prerequisite and gives one question two right answers.
      examiner: (prompt, answer) => {
        if (!prompt.includes('Lesson "Part 2') || broken++ > 0) return undefined;
        for (const item of answer.items) for (const o of [...item.options, ...item.wrong_orders]) o.gap = null;
        answer.items[0]!.options[1]!.correct = true;
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models);
    built(result);
    const part2 = models.examiner.prompts.filter((p) => p.includes('Lesson "Part 2'));
    assert.equal(part2.length, 2);
    assert.match(part2[1]!, /REJECTED/);
    assert.match(part2[1]!, /no wrong option reveals a gap in prerequisite/);
    assert.match(part2[1]!, /exactly one correct option/);
    const validate = stages(result, "validate");
    assert.equal(validate[0]!.status, "rejected");
    assert.equal(validate.at(-1)!.status, "ok");
  });

  it("gives up after the bounded rounds and returns the problems", async () => {
    const models = spiedModels({
      examiner: (prompt, answer) => {
        if (!prompt.includes('Lesson "Part 3')) return undefined;
        answer.misconceptions = [];
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models, { review: false, stress: false });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.problems.some((p) => /misconceptions \(there are 0\)/.test(p)));
    assert.equal(models.examiner.prompts.filter((p) => p.includes('Lesson "Part 3')).length, 1 + MAX_FIX_ROUNDS);
    assert.equal(stages(result, "done")[0]!.status, "rejected");
  });

  it("sends a rejected plan back to the planner", async () => {
    const models = spiedModels({ planner: (_, answer, call) => (call === 1 ? { lessons: answer.lessons.slice(0, 2) } : undefined) });
    const result = await buildCourse(INPUT, models, { review: false, stress: false });
    built(result);
    assert.equal(models.planner.prompts.length, 2);
    assert.match(models.planner.prompts[1]!, /the plan has 2 lessons; it needs 3 to 8/);
  });

  it("stops at the call budget", async () => {
    const result = await buildCourse(INPUT, spiedModels(), { maxCalls: 5 });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /Stopped after 5 model calls/.test(result.problems[0]!));
    assert.equal(result.report.model_calls, 5);
  });
});

describe("grounding", () => {
  const section: PlannedSection = { id: "l/s", title: "S", pages: [{ source: "s1", page: 2 }] };
  const check = {
    prompt: "Which is right?",
    options: [
      { text: "This", correct: true, feedback: "Yes." },
      { text: "That", correct: false, feedback: "No." },
    ],
  };

  it("rejects a block without citations and one citing a page the section wasn't given", () => {
    const { section: written, problems } = sectionFromDraft(
      {
        blocks: [
          { markdown: "Uncited claim.", cites: [] },
          { markdown: "Cited elsewhere.", cites: [{ source: "s1", page: 3 }] },
          { markdown: "Fine.", cites: [{ source: "s1", page: 2 }] },
        ],
        check,
      },
      section,
    );
    assert.equal(written, undefined);
    assert.equal(problems.length, 2);
    assert.match(problems[0]!, /block 1 cites no page/);
    assert.match(problems[1]!, /block 2 cites s1 p\.3, which is not one of this section's pages \(s1 p\.2\)/);
  });

  it("flags uncited blocks and citations to missing or assessment pages in a snapshot", async () => {
    const snapshot = built(await buildCourse(INPUT, spiedModels(), { review: false, stress: false }));
    const blocks = snapshot.lessons[0]!.sections[0]!.blocks.filter(isTextBlock);
    blocks[0]!.cites = [];
    blocks.push({ ...blocks[0]!, id: `${blocks[0]!.id}x`, cites: [{ source: "s1", page: 9 }] });
    blocks.push({ ...blocks[0]!, id: `${blocks[0]!.id}y`, cites: [{ source: "s2", page: 1 }] });
    snapshot.lessons[0]!.sections[0]!.blocks.push(...blocks.slice(1));
    const messages = studioChecks(snapshot, [{ ...NOTES, role: "material" }, { ...EXAM, role: "assessment" }]).map((p) => p.message);
    assert.ok(messages.some((m) => /cites no source page/.test(m)));
    assert.ok(messages.some((m) => /cites s1 p\.9, which doesn't exist/.test(m)));
    assert.ok(messages.some((m) => /cites s2 p\.1, which is assessment, not teaching material/.test(m)));
  });

  it("rewrites a section whose first draft cites a wrong page", async () => {
    let calls = 0;
    const models = spiedModels({
      writer: (_, answer) => {
        if (calls++ > 0) return undefined;
        answer.blocks[0]!.cites = [{ source: "s1", page: 7 }];
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models, { review: false, stress: false, concurrency: 1 });
    built(result);
    assert.equal(models.writer.prompts.length, 7); // 6 sections + 1 fix
    assert.match(models.writer.prompts[6]!, /block 1 cites s1 p\.7/);
  });

  it("rewrites a section the fact checker doubts, and warns if it still does", async () => {
    let flagged = 0;
    const models = spiedModels({
      fact_checker: (prompt) =>
        prompt.includes('Section "Pruning') && flagged++ < 3 ? { supported: false, unsupported: ['"every third day": the page says weekly'] } : undefined,
    });
    const result = await buildCourse(INPUT, models, { stress: false, concurrency: 1 });
    built(result);
    const revisions = models.writer.prompts.filter((p) => p.includes("A fact check found claims"));
    assert.equal(revisions.length, 2); // two "Pruning" sections, each rewritten once
    assert.ok(result.report.warnings.some((w) => /may state things its pages don't support, even after a rewrite/.test(w)));
  });

  it("sanitizes Markdown the app renders as HTML", () => {
    assert.equal(sanitizeMarkdown("## Title\nText <script>x</script> [a](javascript:alert) ![i](http://x/y.png) [ok](https://e.org)"), "**Title**\nText &lt;script>x&lt;/script> a i [ok](https://e.org)");
    assert.equal(sanitizeMarkdown("Use `<div>` here"), "Use `<div>` here");
    assert.equal(sanitizeMarkdown("```html\n<b>\n```"), "```html\n<b>\n```");
    assert.equal(sanitizeMarkdown("```\nopen"), "```\nopen\n```");
  });
});

describe("assessments are never copied", () => {
  const sources = [{ ...EXAM, role: "assessment" as const }];

  it("finds a prompt that rewords an exam sentence, and ignores short generic ones", () => {
    const sentences = assessmentSentences(sources);
    assert.equal(sentences.length, 2);
    assert.ok(copiedSentence("How would a keeper determine the spacing of notches on a winter clock trellis?", sentences));
    assert.equal(copiedSentence("Why does a bramble clock run late?", sentences), undefined);
  });

  it("sends a copied question back to the examiner", async () => {
    let copied = 0;
    const models = spiedModels({
      examiner: (prompt, answer) => {
        if (!prompt.includes('Lesson "Part 1') || copied++ > 0) return undefined;
        answer.items[0]!.prompt = "Describe how a keeper would determine the spacing of notches on a trellis for a winter clock.";
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models, { review: false, stress: false });
    const snapshot = built(result);
    assert.match(models.examiner.prompts.filter((p) => p.includes('Lesson "Part 1'))[1]!, /question 1 copies an assessment question \(s2 p\.1\)/);
    assert.ok(snapshot.lessons.every((l) => l.quiz.every((item) => !item.prompt.startsWith("Describe how a keeper"))));
  });

  it("drops digest points that copy an exam's wording", async () => {
    const models = spiedModels({
      digester: (prompt, answer) =>
        prompt.includes("This is an assessment")
          ? { points: [...answer.points, { text: "A clock has started running late during a dry week; explain the cause and the remedy.", pages: [1] }] }
          : undefined,
    });
    const result = await buildCourse(INPUT, models, { review: false, stress: false });
    built(result);
    assert.match(stages(result, "digest")[1]!.detail!, /1 point\(s\) that copied the document's wording were dropped/);
    for (const prompt of [...models.planner.prompts, ...models.examiner.prompts]) assert.ok(!prompt.includes("running late during a dry week"));
  });

  it("never shows the examiner the exam's own text", async () => {
    const models = spiedModels();
    built(await buildCourse(INPUT, models, { review: false, stress: false }));
    for (const prompt of models.examiner.prompts) assert.ok(!prompt.includes("Describe how a keeper would determine"));
  });
});

describe("stress test", () => {
  it("is skipped when the course has no prerequisite edges", async () => {
    const models = spiedModels({
      planner: (_, answer) => ({ lessons: answer.lessons.map((l) => ({ ...l, prerequisites: [] })) }),
    });
    const result = await buildCourse(INPUT, models, { review: false });
    built(result);
    const stress = stages(result, "stress")[0]!;
    assert.equal(stress.status, "info");
    assert.match(stress.title, /skipped/);
  });

  it("misses the removed edge when few questions can reveal it, and says so", async () => {
    // Only the first question of each lesson keeps its gap tag: valid, but thin evidence.
    const models = spiedModels({
      examiner: (_, answer) => {
        answer.items.slice(1).forEach((item) => [...item.options, ...item.wrong_orders].forEach((o) => (o.gap = null)));
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models, { review: false });
    const snapshot = built(result);
    assert.ok(result.report.warnings.some((w) => /Only 1 of 6 questions .* can reveal a gap/.test(w)));
    const outcome = stressTest(snapshot);
    assert.equal(outcome.outcome, "missed");
    assert.ok(result.report.warnings.some((w) => /^Stress test: /.test(w)));
  });
});

describe("helpers", () => {
  it("fits prompts to a budget, shortening only elastic parts", () => {
    const text = fitParts([{ text: "head" }, { text: "x".repeat(100), elastic: true, before: "<p>", after: "</p>" }, { text: "y".repeat(10), elastic: true }], 60);
    assert.ok(text.length <= 60);
    assert.ok(text.startsWith("head\n\n<p>x"));
    assert.ok(text.includes("</p>\n\nyyyyyyyyyy"));
  });

  it("thins long lists evenly instead of cutting their end", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(2, "0")}`);
    const { lines: kept, dropped } = thinLines(lines, 200);
    assert.ok(kept.join("\n").length <= 200);
    assert.equal(kept.length + dropped, 100);
    assert.ok(kept.at(-1)! > "line 80");
  });

  it("reads a role from a file name only on whole words", () => {
    assert.equal(roleFromName("2023-final-exam.pdf"), "assessment");
    assert.equal(roleFromName("Lec03_caches.pdf"), "material");
    assert.equal(roleFromName("project-brief.md"), "brief");
    assert.equal(roleFromName("latest-results.pdf"), undefined);
  });

  it("asks the classifier only about files without a hint", async () => {
    const models = spiedModels();
    const result = await buildCourse({ ...INPUT, sources: [{ ...NOTES, name: "bramble.md" }, { ...EXAM, role: "assessment" }] }, models, { review: false, stress: false });
    built(result);
    assert.equal(models.classifier.prompts.length, 1);
    assert.match(models.classifier.prompts[0]!, /<document>\nA bramble clock/);
  });
});
