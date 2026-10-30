import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CourseSnapshot, courseFromSnapshot, isTextBlock } from "../course/compile.js";
import type { Source } from "../course/sources.js";
import { buildCourse } from "../generate/build.js";
import { cannedBuilderModels, responder } from "../generate/canned.js";
import { EXAM, INPUT, NOTES } from "../generate/fixtures.test-helpers.js";
import { applyChanges, invertChanges } from "../releases/changes.js";
import type { EditModels } from "./models.js";
import { type EditContext, runEdit } from "./run.js";
import type { EditPlanDraft } from "./schemas.js";
import type { EditResult } from "./types.js";

const EMPTY: EditPlanDraft = { reply: "", rewrite_sections: [], new_sections: [], new_lessons: [], new_objectives: [], more_questions: [] };

async function course(): Promise<CourseSnapshot> {
  const result = await buildCourse(INPUT, cannedBuilderModels());
  assert.ok(result.ok, result.ok ? "" : result.problems.join("\n"));
  return result.snapshot;
}

/** Canned models plus an editor that answers with the given plans in turn, recording every prompt. */
function models(...plans: EditPlanDraft[]) {
  const prompts: Record<string, string[]> = { editor: [], writer: [], examiner: [], digester: [] };
  const canned = cannedBuilderModels();
  const spy = <T,>(name: string, inner: { invoke: (m: never) => Promise<T> }) => ({
    invoke: async (messages: never) => {
      const last = (messages as { content: unknown }[]).at(-1)!.content;
      (prompts[name] ??= []).push(typeof last === "string" ? last : JSON.stringify(last));
      return inner.invoke(messages);
    },
  });
  let n = 0;
  const editor = responder(() => plans[Math.min(n++, plans.length - 1)] ?? EMPTY);
  const all = {
    ...canned,
    writer: spy("writer", canned.writer),
    examiner: spy("examiner", canned.examiner),
    digester: spy("digester", canned.digester),
    editor: spy("editor", editor),
  } as unknown as EditModels;
  return { models: all, prompts };
}

const ctx = (snapshot: CourseSnapshot, sources: Source[] = [{ ...NOTES, role: "material" }, { ...EXAM, role: "assessment" }]): EditContext => ({
  course: { course_id: INPUT.course_id, title: INPUT.title },
  snapshot,
  sources,
});

const proposed = (result: EditResult) => {
  assert.ok(result.ok, result.ok ? "" : result.problems.join("\n"));
  return result.proposal;
};

/** The changes make a valid course, and their inverse gives the original back exactly. */
function appliesCleanly(base: CourseSnapshot, changes: Parameters<typeof applyChanges>[1]) {
  const next = applyChanges(base, changes);
  assert.doesNotThrow(() => courseFromSnapshot(next));
  assert.deepEqual(applyChanges(next, invertChanges(base, changes)), base);
  return next;
}

describe("owner edits", () => {
  it("tunes one section with a preset: the old text is archived and the new text added", async () => {
    const base = await course();
    const section = base.lessons[0]!.sections[0]!;
    const { models: m, prompts } = models();
    const proposal = proposed(await runEdit({ kind: "tune", section_id: section.id, preset: "plainer", instruction: "Mention dawn watering." }, ctx(base), m));

    assert.equal(prompts.editor!.length, 0, "a tune needs no plan");
    assert.match(prompts.writer![0]!, /Use plainer language/);
    assert.match(prompts.writer![0]!, /Mention dawn watering/);
    assert.match(prompts.writer![0]!, /<current>/);
    assert.equal(proposal.summary.length, 1);
    assert.equal(proposal.summary[0]!.kind, "rewrite");
    assert.ok(proposal.summary[0]!.before && proposal.summary[0]!.after);

    const next = appliesCleanly(base, proposal.changes);
    const after = next.lessons[0]!.sections[0]!;
    const old = section.blocks.map((b) => b.id);
    assert.ok(after.blocks.filter((b) => old.includes(b.id)).every((b) => b.archived), "the old blocks stay, archived");
    assert.ok(after.blocks.some((b) => !b.archived && isTextBlock(b) && !old.includes(b.id)), "new text blocks with new ids");
    assert.equal(after.blocks.filter((b) => !b.archived && b.kind === "check").length, 1, "one live practice question");
  });

  it("refuses a tune with nothing to do, or of a section that doesn't exist", async () => {
    const base = await course();
    const { models: m } = models();
    const none = await runEdit({ kind: "tune", section_id: base.lessons[0]!.sections[0]!.id }, ctx(base), m);
    assert.equal(none.ok, false);
    const missing = await runEdit({ kind: "tune", section_id: "nope/nope", preset: "plainer" }, ctx(base), m);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.problems.join(), /not a section id/);
  });

  it("turns a request into new sections, objectives, questions and a lesson", async () => {
    const base = await course();
    const [l1, l2] = base.lessons;
    const last = base.lessons.at(-1)!;
    const objective = base.objectives!.find((o) => o.lesson === l1!.id)!;
    const plan: EditPlanDraft = {
      reply: "I'll add a section on pruning, an objective, more questions and a lesson on replacing stems.",
      rewrite_sections: [],
      new_sections: [{ lesson: l2!.id, after: l2!.sections[0]!.id, title: "Pruning side shoots", pages: [{ source: "s1", page: 3 }], objectives: [], instruction: "Explain why side shoots are cut." }],
      new_objectives: [{ lesson: l2!.id, statement: "Explain why keepers prune side shoots", sections: ["Pruning side shoots"] }],
      more_questions: [{ objective: objective.id, instruction: "Ask about dry soil." }],
      new_lessons: [
        {
          after: last.id,
          title: "Replacing old stems",
          summary: "When and why stems are replaced.",
          prerequisites: [last.id],
          sections: [{ title: "Spring replacement", pages: [{ source: "s1", page: 3 }] }],
          objectives: [
            { statement: "Explain why stems are replaced in spring", sections: [1] },
            { statement: "Order the steps of replacing a stem", sections: [1] },
          ],
        },
      ],
    };
    const { models: m, prompts } = models(plan);
    const proposal = proposed(await runEdit({ kind: "ask", instruction: "Cover pruning and stem replacement better." }, ctx(base), m));

    assert.match(prompts.editor![0]!, /Cover pruning and stem replacement better/);
    assert.match(prompts.editor![0]!, /Page index of the teaching material/);
    assert.equal(proposal.reply, plan.reply);
    assert.deepEqual(proposal.summary.map((s) => s.kind).sort(), ["new_lesson", "new_questions", "new_questions", "new_section"]);

    const next = appliesCleanly(base, proposal.changes);
    const lesson2 = next.lessons.find((l) => l.id === l2!.id)!;
    assert.equal(lesson2.sections[1]!.title, "Pruning side shoots", "placed after the section named");
    const added = next.objectives!.find((o) => o.statement === "Explain why keepers prune side shoots")!;
    assert.deepEqual(added.sections, [lesson2.sections[1]!.id]);
    assert.ok(lesson2.quiz.filter((q) => q.objective === added.id).length >= 1);
    const more = next.lessons[0]!.quiz.length - l1!.quiz.length;
    assert.ok(more >= 1, "more questions for the first lesson");
    assert.equal(new Set(next.lessons[0]!.quiz.map((q) => q.id)).size, next.lessons[0]!.quiz.length, "question ids stay unique");
    const newLesson = next.lessons.at(-1)!;
    assert.equal(newLesson.title, "Replacing old stems");
    assert.deepEqual(newLesson.prerequisites, [last.id]);
    assert.ok(newLesson.quiz.length >= 4 && newLesson.exam);
    assert.equal(next.objectives!.filter((o) => o.lesson === newLesson.id).length, 2);
  });

  it("sends an edit list with unknown ids back once, then keeps only the valid part", async () => {
    const base = await course();
    const good = base.lessons[1]!.sections[0]!.id;
    const bad: EditPlanDraft = { ...EMPTY, rewrite_sections: [{ section: "made-up/section", instruction: "x" }, { section: good, instruction: "Shorter." }] };
    const { models: m, prompts } = models(bad, bad);
    const result = await runEdit({ kind: "ask", instruction: "Shorten things." }, ctx(base), m);
    assert.equal(prompts.editor!.length, 2);
    assert.match(prompts.editor![1]!, /REJECTED[\s\S]*"made-up\/section" is not a section id/);
    const proposal = proposed(result);
    assert.deepEqual(proposal.summary.map((s) => s.kind), ["rewrite"]);
    assert.ok(!result.ok || result.warnings.some((w) => /left out/.test(w)));
  });

  it("reads a file added after the build and writes what it adds", async () => {
    const base = await course();
    const extra: Source = { id: "s3", name: "frost-notes.md", role: "material", pages: ["Frost cloths protect the tip on cold nights. A covered tip keeps growing at night, so the clock stays on time."] };
    const lessonId = base.lessons[0]!.id;
    const plan: EditPlanDraft = {
      ...EMPTY,
      reply: "A section on frost cloths.",
      new_sections: [{ lesson: lessonId, after: null, title: "Frost cloths", pages: [{ source: "s3", page: 1 }], objectives: [], instruction: "From the new notes." }],
    };
    const { models: m, prompts } = models(plan);
    const proposal = proposed(await runEdit({ kind: "add_source", source_id: "s3", instruction: "Winter care" }, ctx(base, [{ ...NOTES, role: "material" }, { ...EXAM, role: "assessment" }, extra]), m));
    assert.ok(prompts.digester!.some((p) => p.includes("Frost cloths")), "the new file is read");
    assert.match(prompts.editor![0]!, /Key ideas of the new file:[\s\S]*\[s3 p\.1\]/);
    assert.match(prompts.editor![0]!, /Their note: "Winter care"/);
    const next = appliesCleanly(base, proposal.changes);
    const first = next.lessons[0]!.sections[0]!;
    assert.equal(first.title, "Frost cloths");
    assert.ok(first.blocks.filter(isTextBlock).every((b) => b.cites?.every((c) => c.source === "s3")));
  });

  it("says why when the request leads to no change, and never cites an assessment", async () => {
    const base = await course();
    const { models: m } = models({ ...EMPTY, reply: "The pages don't cover quantum clocks." });
    const none = await runEdit({ kind: "ask", instruction: "Add quantum clocks." }, ctx(base), m);
    assert.equal(none.ok, false);
    assert.match(none.ok ? "" : none.problems.join(), /quantum clocks/);

    const cites: EditPlanDraft = { ...EMPTY, new_sections: [{ lesson: base.lessons[0]!.id, after: null, title: "Exam tips", pages: [{ source: "s2", page: 1 }], objectives: [], instruction: "x" }] };
    const { models: m2 } = models(cites, cites);
    const refused = await runEdit({ kind: "ask", instruction: "Add exam tips." }, ctx(base), m2);
    assert.equal(refused.ok, false, "nothing valid is left");
  });
});
