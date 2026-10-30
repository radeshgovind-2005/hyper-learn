import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stampRetryable } from "@langchain/core/errors";
import { type CourseSnapshot, courseFromSnapshot, isTextBlock } from "../course/compile.js";
import { mergeDrafts, problemsByPart } from "./assess.js";
import { buildCourse, MAX_FIX_ROUNDS } from "./build.js";
import { CallBudgetExceeded, isRetryable, ModelCalls } from "./models.js";
import { assessmentSentences, copiedSentence, routeValidationError, studioChecks } from "./checks.js";
import { EXAM, INPUT, NOTES, spiedModels, totalCalls } from "./fixtures.test-helpers.js";
import type { PlannedSection } from "./plan.js";
import type { AssessmentDraft, ItemDraft } from "./schemas.js";
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
      assert.deepEqual(lesson.exam, { per_objective: 2 });
      const objectives = snapshot.objectives!.filter((o) => o.lesson === lesson.id);
      assert.ok(objectives.length >= 2);
      for (const o of objectives) assert.ok(lesson.quiz.filter((item) => item.objective === o.id).length >= 5);
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
    // 2 digests + plan + 6 sections + 6 objectives (one examiner call each) + 6 fact checks
    assert.equal(result.report.model_calls, 21);
    assert.equal(models.examiner.prompts.length, 6);
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
    const models = spiedModels({
      // The first drafts for the second lesson forget its prerequisite, and O2's first question has two right answers.
      examiner: (prompt, answer) => {
        if (!prompt.includes('Lesson "Part 2') || prompt.includes("REJECTED")) return undefined;
        for (const item of answer.items) for (const o of [...item.options, ...item.wrong_orders]) o.gap = null;
        if (prompt.includes("for objective O2")) answer.items[0]!.options[1]!.correct = true;
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models);
    built(result);
    const part2 = models.examiner.prompts.filter((p) => p.includes('Lesson "Part 2'));
    // Both objectives' calls, then both again: a missing gap is the whole lesson's problem.
    assert.equal(part2.length, 4);
    const [o1, o2] = [1, 2].map((k) => part2.find((p) => p.includes("REJECTED") && p.includes(`for objective O${k}`))!);
    for (const retry of [o1!, o2!]) assert.match(retry, /no wrong option reveals a gap in prerequisite/);
    // The broken question goes back only to the call that wrote it, numbered as that call saw it.
    assert.match(o2!, /question 1: .*exactly one correct option/);
    assert.doesNotMatch(o1!, /exactly one correct option/);
    const validate = stages(result, "validate");
    assert.equal(validate[0]!.status, "rejected");
    assert.equal(validate.at(-1)!.status, "ok");
  });

  it("routes the validator's problems to the section or lesson they name", async () => {
    const snapshot = built(await buildCourse(INPUT, spiedModels(), { review: false, stress: false }));
    const [l1, l2] = snapshot.lessons;
    const section = l1!.sections[1]!;
    const routed = routeValidationError(
      snapshot,
      [
        `Course "${snapshot.course_id}" is invalid:`,
        `Question "${l2!.quiz[0]!.id}" in "${l2!.id}": it must have exactly one correct option (has 2)`,
        `Check "${section.blocks.at(-1)!.id}" must have exactly one correct option (has 0)`,
        `Objective "${snapshot.objectives![0]!.id}" has 1 scored questions`,
        `Misconception "${snapshot.misconceptions.at(-1)!.id}" is never revealed by any wrong answer`,
        "Something about the whole course",
      ].join("\n- "),
    );
    assert.deepEqual(
      routed.map(({ lesson, section }) => ({ lesson, section })),
      [
        { lesson: l2!.id, section: undefined },
        { lesson: undefined, section: section.id },
        { lesson: l1!.id, section: undefined },
        { lesson: snapshot.lessons.at(-1)!.id, section: undefined },
        { lesson: undefined, section: undefined },
      ],
    );
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
    // Without misconceptions, both objectives' calls are made again every round.
    assert.equal(models.examiner.prompts.filter((p) => p.includes('Lesson "Part 3')).length, 2 * (1 + MAX_FIX_ROUNDS));
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
    const retries = models.examiner.prompts.filter((p) => p.includes('Lesson "Part 1') && p.includes("REJECTED"));
    // Only the call that wrote the copy is asked again.
    assert.equal(retries.length, 1);
    assert.match(retries[0]!, /for objective O1/);
    assert.match(retries[0]!, /question 1 copies an assessment question \(s2 p\.1\)/);
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
      examiner: (prompt, answer) => {
        answer.items.slice(prompt.includes("for objective O1") ? 1 : 0).forEach((item) => [...item.options, ...item.wrong_orders].forEach((o) => (o.gap = null)));
        return answer;
      },
    });
    const result = await buildCourse(INPUT, models, { review: false });
    const snapshot = built(result);
    assert.ok(result.report.warnings.some((w) => /Only 1 of 10 questions .* can reveal a gap/.test(w)));
    const outcome = stressTest(snapshot);
    assert.equal(outcome.outcome, "missed");
    assert.ok(result.report.warnings.some((w) => /^Stress test: /.test(w)));
  });
});

describe("one examiner call per objective", () => {
  const item = (prompt: string): ItemDraft => ({
    objective: 9,
    type: "single_choice",
    prompt,
    options: [],
    reason_prompt: null,
    reasons: [],
    steps: [],
    wrong_orders: [],
  });
  const part = (prompts: string[], misconceptions: AssessmentDraft["misconceptions"] = []): AssessmentDraft => ({ misconceptions, items: prompts.map(item) });

  it("merges the calls' questions in order, with the first call's misconceptions and each call's objective", () => {
    const { draft, owners } = mergeDrafts([part(["a", "b"], [{ name: "m", belief: "x" }]), part(["c"], [{ name: "ignored", belief: "y" }])]);
    assert.deepEqual(draft.items.map((i) => [i.prompt, i.objective]), [["a", 1], ["b", 1], ["c", 2]]);
    assert.deepEqual(draft.misconceptions.map((m) => m.name), ["m"]);
    assert.deepEqual(owners, [0, 0, 1]);
  });

  it("sends each problem to the call that can fix it, numbered as that call saw it", () => {
    const owners = [0, 0, 1, 1, 1];
    const byPart = problemsByPart(
      [
        "question 4, option 2: gap \"x\" is not a prerequisite",
        'Question "part-2-q2" in "part-2": it must have exactly one correct option',
        "objective 2 has 3 questions; write at least 5",
        'Objective "part-2-o1" has 1 scored questions',
        "write 2 to 4 misconceptions (there are 0)",
        'no wrong option reveals a gap in prerequisite "part-1"; tag one in most questions',
      ],
      owners,
      2,
      "part-2",
    );
    assert.deepEqual(byPart[0], [
      'question 2 in "part-2": it must have exactly one correct option',
      'Objective "part-2-o1" has 1 scored questions',
      "write 2 to 4 misconceptions (there are 0)",
      'no wrong option reveals a gap in prerequisite "part-1"; tag one in most questions',
    ]);
    assert.deepEqual(byPart[1], [
      "question 2, option 2: gap \"x\" is not a prerequisite",
      "objective 2 has 3 questions; write at least 5",
      'no wrong option reveals a gap in prerequisite "part-1"; tag one in most questions',
    ]);
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

describe("small inputs", () => {
  it("asks for fewer lessons when the material has fewer pages than the minimum", async () => {
    const models = spiedModels();
    const result = await buildCourse({ ...INPUT, sources: [{ ...NOTES, pages: NOTES.pages.slice(0, 2) }] }, models, { review: false, stress: false });
    const snapshot = built(result);
    assert.match(models.planner.prompts[0]!, /Plan 2 to 8 lessons/);
    assert.equal(snapshot.lessons.length, 2);
    assert.ok(result.report.warnings.some((w) => /only 2 page\(s\)/.test(w)));
  });
});

describe("budgets on a large input", () => {
  it("chunks, samples and shortens so that every call fits maxChars", async () => {
    const page = (n: number) => `Page ${n} explains bramble rule number ${n}. ${"Keepers repeat this rule while they work along the trellis. ".repeat(40)}`;
    const big = { id: "s1", name: "big-notes.md", pages: Array.from({ length: 60 }, (_, i) => page(i + 1)) };
    const models = spiedModels();
    const maxChars = 9_000;
    const result = await buildCourse({ ...INPUT, sources: [big, EXAM] }, models, { maxChars, stress: false });
    built(result);
    for (const [name, model] of Object.entries(models)) {
      for (const size of model.sizes) assert.ok(size <= maxChars, `${name} call of ${size} characters`);
    }
    assert.ok(models.digester.prompts.length > 2, "the material is read in several chunks");
    assert.ok(result.report.warnings.some((w) => /sample of the material's key ideas/.test(w)));
  });
});

describe("model call retries", () => {
  const failing = (errors: unknown[]) => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      invoke: async () => {
        const error = errors[calls++];
        if (error) throw error;
        return "ok";
      },
    };
  };
  const httpError = (status: number) => Object.assign(new Error(`${status} error`), { status });
  const setup = (maxCalls = 10) => {
    const waits: number[] = [];
    const calls = new ModelCalls(24_000, maxCalls, { sleep: async (ms) => void waits.push(ms) });
    return { calls, waits };
  };

  it("retries a server error after growing waits", async () => {
    const { calls, waits } = setup();
    const model = failing([httpError(500), httpError(503), new Error("socket hang up")]);
    assert.equal(await calls.invoke(model, "writer", "x"), "ok");
    assert.deepEqual(waits, [2_000, 8_000, 30_000]);
    assert.equal(calls.count, 4, "every attempt counts toward the build's limit");
  });

  it("gives up after the last wait", async () => {
    const { calls, waits } = setup();
    const model = failing([httpError(500), httpError(500), httpError(500), httpError(502)]);
    await assert.rejects(calls.invoke(model, "writer", "x"), /502 error/);
    assert.equal(waits.length, 3);
  });

  it("doesn't retry an error that would fail the same way", async () => {
    const { calls, waits } = setup();
    await assert.rejects(calls.invoke(failing([httpError(401)]), "writer", "x"), /401/);
    assert.deepEqual(waits, []);
    assert.equal(isRetryable(httpError(400)), false);
    assert.equal(isRetryable(httpError(429)), true);
    assert.equal(isRetryable(new Error("no status")), true);
  });

  it("follows LangChain's own mark", () => {
    assert.equal(isRetryable(stampRetryable(httpError(429), false)), false, "an exhausted quota");
    assert.equal(isRetryable(stampRetryable(new Error("context window"), false)), false);
    assert.equal(isRetryable(stampRetryable(httpError(400), true)), true);
  });

  it("stops retrying at the build's call limit", async () => {
    const { calls } = setup(2);
    await assert.rejects(calls.invoke(failing([httpError(500), httpError(500)]), "writer", "x"), CallBudgetExceeded);
    assert.equal(calls.count, 2);
  });
});
