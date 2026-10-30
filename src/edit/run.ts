import type { QuizItem } from "../assessment/items.js";
import { type CheckBlock, type CourseSnapshot, courseFromSnapshot, isTextBlock, KIND_PREFIX, type LessonNode, type Section, type TextBlock } from "../course/compile.js";
import type { Citation, MisconceptionDef, Objective } from "../course/schema.js";
import type { Source } from "../course/sources.js";
import { shuffleCheck, shuffleItem } from "../generate/assemble.js";
import { assessmentFromDraft, examinerPrompt, mergeDrafts, problemsByPart } from "../generate/assess.js";
import { retryText } from "../generate/build.js";
import { assessmentSentences, studioChecks } from "../generate/checks.js";
import { CallBudgetExceeded, ModelCalls } from "../generate/models.js";
import type { PlannedLesson, PlannedSection } from "../generate/plan.js";
import { fitParts, mapLimit, pageLabel, thinLines, uniqueSlug } from "../generate/prompt.js";
import { factCheckPrompt } from "../generate/review.js";
import type { AssessmentDraft, SectionDraft } from "../generate/schemas.js";
import { classifySource, digestSource } from "../generate/sources.js";
import type { BuildInput } from "../generate/types.js";
import { sectionFromDraft, type WrittenSection, writerPrompt } from "../generate/write.js";
import { applyChanges, type Change, ChangeError } from "../releases/changes.js";
import type { EditModels } from "./models.js";
import type { EditPlanDraft } from "./schemas.js";
import { EDIT_PRESETS, type EditProposal, type EditRequest, type EditResult, type EditStep, type EditSummaryItem } from "./types.js";

// Owner edits: a request becomes a small set of typed changes to the course, written by the same agents
// that build courses and held to the same checks (citations, validation, fact check). Nothing here
// stores anything: the app shows the proposal and applies it to the draft or releases it.
//
//   request ─► plan (editor agent; a tune skips it) ─► write sections ─► write questions
//           ─► validate each part on the course (a part that breaks it is dropped) ─► fact check ─► changes

export interface EditContext {
  course: Pick<BuildInput, "course_id" | "title" | "goal" | "description" | "language">;
  /** The course the changes apply to: the draft, or the live release. */
  snapshot: CourseSnapshot;
  sources: readonly Source[];
}

export interface EditOptions {
  onStep?: (step: EditStep) => void;
  maxChars?: number;
  maxCalls?: number;
  concurrency?: number;
  /** Fact-check rewritten and new sections (default true). */
  review?: boolean;
}

export const DEFAULT_EDIT_MAX_CALLS = 80;
/** Most questions one request adds to an objective. */
const MAX_MORE_QUESTIONS = 5;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const bullets = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");

/** The course's live lessons as the generator's plan types, so its prompts can be reused. */
export function plannedLessons(snapshot: CourseSnapshot): PlannedLesson[] {
  return snapshot.lessons
    .filter((l) => !l.archived)
    .map((lesson) => ({
      id: lesson.id,
      title: lesson.title,
      summary: lesson.summary,
      prerequisites: [...lesson.prerequisites],
      sections: lesson.sections.filter((s) => !s.archived).map((s) => ({ id: s.id, title: s.title, pages: sectionPages(s) })),
      objectives: (snapshot.objectives ?? []).filter((o) => o.lesson === lesson.id),
    }));
}

/** The pages a section's live text cites, in first-cited order. */
function sectionPages(section: Section): Citation[] {
  const pages: Citation[] = [];
  for (const block of section.blocks) {
    if (block.archived || !isTextBlock(block)) continue;
    for (const c of block.cites ?? []) if (!pages.some((p) => p.source === c.source && p.page === c.page)) pages.push({ ...c });
  }
  return pages;
}

const liveText = (section: Section) => section.blocks.filter((b): b is TextBlock => !b.archived && isTextBlock(b));
const liveCheck = (section: Section) => section.blocks.find((b): b is CheckBlock => !b.archived && b.kind === "check");

/** A section's current text, as the writer and the owner's before/after view see it. */
function sectionMarkdown(section: Section): string {
  const check = liveCheck(section);
  const text = liveText(section).map((b) => b.markdown).join("\n\n");
  return check ? `${text}\n\n**Practice:** ${check.check.prompt}` : text;
}

const writtenMarkdown = (w: WrittenSection) => `${w.blocks.map((b) => b.markdown).join("\n\n")}\n\n**Practice:** ${w.check.prompt}`;

/** The written text of every live section, for the examiner (which reads the lesson). */
function writtenFromSnapshot(snapshot: CourseSnapshot): Map<string, WrittenSection> {
  const map = new Map<string, WrittenSection>();
  for (const lesson of snapshot.lessons) {
    for (const section of lesson.sections) {
      const check = liveCheck(section);
      const blocks = liveText(section).map((b) => ({ kind: b.kind, markdown: b.markdown, cites: b.cites ?? [] }));
      if (blocks.length > 0) map.set(section.id, { blocks, check: check?.check ?? { prompt: "", options: [] } });
    }
  }
  return map;
}

/** Fresh block ids in a section, continuing its numbering per kind (archived blocks keep theirs). */
function blockIds(snapshot: CourseSnapshot, sectionId: string, taken: Set<string>) {
  const all = new Set(taken);
  for (const l of snapshot.lessons) for (const s of l.sections) for (const b of s.blocks) all.add(b.id);
  return (kind: keyof typeof KIND_PREFIX) => {
    for (let n = 1; ; n++) {
      const id = `${sectionId}/${KIND_PREFIX[kind]}${n}`;
      if (!all.has(id)) {
        all.add(id);
        taken.add(id);
        return id;
      }
    }
  };
}

/** A written section as blocks with ids; its check practises `objective` when given. */
function blocksOf(courseId: string, written: WrittenSection, nextId: ReturnType<typeof blockIds>, objective?: string) {
  const text: TextBlock[] = written.blocks.map((b) => ({ id: nextId(b.kind), kind: b.kind, markdown: b.markdown, cites: b.cites.map((c) => ({ ...c })), archived: false }));
  const check: CheckBlock = shuffleCheck(courseId, { id: nextId("check"), kind: "check", check: written.check, archived: false, ...(objective && { objective }) });
  return { text, check };
}

/** One part of an edit: the changes it makes, validated together, and how the owner sees it. */
interface Unit {
  changes: Change[];
  summary: EditSummaryItem;
}

export async function runEdit(request: EditRequest, ctx: EditContext, models: EditModels, options: EditOptions = {}): Promise<EditResult> {
  const calls = new ModelCalls(options.maxChars ?? 24_000, options.maxCalls ?? DEFAULT_EDIT_MAX_CALLS);
  const concurrency = options.concurrency ?? 4;
  const warnings: string[] = [];
  const warn = (w: string) => !warnings.includes(w) && warnings.push(w);
  const step = (stage: EditStep["stage"], title: string, status: EditStep["status"] = "ok", detail?: string) =>
    options.onStep?.({ stage, title, status, at: new Date().toISOString(), ...(detail && { detail }) });
  const fail = (problems: string[]): EditResult => {
    step("done", "No change was proposed", "rejected", bullets(problems.slice(0, 10)));
    return { ok: false, problems, warnings, model_calls: calls.count };
  };

  try {
    const base = ctx.snapshot;
    const input: BuildInput = { ...ctx.course, sources: [...ctx.sources] };
    const perObjective = base.lessons.find((l) => l.exam)?.exam?.per_objective ?? 2;

    // Roles the owner left to the build are decided again (by file name first, so usually free).
    const sources: (Source & { role: NonNullable<Source["role"]> })[] = [];
    for (const original of ctx.sources) sources.push((await classifySource(original, models, calls)).source);
    const material = sources.filter((s) => s.role === "material");
    const lessons = plannedLessons(base);

    // 1. What changes.
    let plan: EditPlanDraft;
    if (request.kind === "tune") {
      const words = [request.preset && EDIT_PRESETS[request.preset], request.instruction?.trim()].filter(Boolean).join(" ");
      if (!words) return fail(["Pick a preset or say what to change"]);
      plan = { reply: "", rewrite_sections: [{ section: request.section_id, instruction: words }], new_sections: [], new_lessons: [], new_objectives: [], more_questions: [] };
    } else {
      let ideas = "";
      let header: string;
      if (request.kind === "add_source") {
        const added = sources.find((s) => s.id === request.source_id);
        if (!added) return fail([`No file "${request.source_id}"`]);
        const { digest } = await digestSource(added, models, calls);
        step("digest", `Read ${added.name}`, "ok", `${digest.points.length} key point(s)`);
        ideas = digest.points.map((p) => `- [${added.id} p.${p.pages.join(",")}] ${p.text}`).join("\n");
        header = [
          `The owner added the file "${added.name}" (${added.id}, ${added.role}, ${added.pages.length} pages) to the course.`,
          request.instruction?.trim() ? `Their note: "${request.instruction.trim()}"` : "They left no note.",
          added.role === "material"
            ? "Propose what it adds: new sections or lessons for what the course doesn't cover yet, rewrites where it improves an existing section. Leave out what the course already covers."
            : "It is an assessment or brief: don't cite it. Propose more_questions (and rewrites, if it shows the course misses something it evaluates).",
        ].join("\n");
      } else {
        header = `The owner's request: "${request.instruction.trim()}"`;
      }
      const room = calls.room("editor");
      const prompt = editorPrompt(input, base, lessons, material, header, ideas, room);
      let draft: EditPlanDraft | undefined;
      let problems: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const fix = attempt > 0 ? `\n\n${retryText("editor", "fix", draft, problems, room)}` : "";
        draft = await calls.invoke(models.editor, "editor", attempt > 0 ? fitParts([{ text: prompt, elastic: true }, { text: fix }], room) : prompt);
        problems = checkPlan(draft, base, sources);
        if (problems.length === 0) break;
        step("plan", `Edit list rejected (attempt ${attempt + 1})`, "rejected", bullets(problems));
      }
      plan = draft!;
      if (problems.length > 0) {
        plan = keepValid(plan, base, sources);
        warn(`Some proposed edits were left out: ${problems.join("; ")}`);
      }
    }
    if (request.kind === "tune") {
      const problems = checkPlan(plan, base, sources);
      if (problems.length > 0) return fail(problems);
    }
    plan = merged(plan);
    const planned = plan.rewrite_sections.length + plan.new_sections.length + plan.new_lessons.length + plan.new_objectives.length + plan.more_questions.length;
    if (planned === 0) return fail([plan.reply || "The request didn't lead to any change"]);
    step("plan", describePlan(plan), "ok", plan.reply || undefined);

    // Writing a section: the generator's writer, with the owner's request and (for a rewrite) the current text.
    const sentences = assessmentSentences(sources);
    const write = async (lesson: PlannedLesson, section: PlannedSection, request: string): Promise<{ written?: WrittenSection; draft?: SectionDraft; problems: string[] }> => {
      let draft: SectionDraft | undefined;
      let problems: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const room = calls.room("writer");
        const fix = attempt > 0 ? retryText("writer", "fix", draft, problems, room) : "";
        try {
          draft = await calls.invoke(models.writer, "writer", writerPrompt({ input, sources, lesson, section }, room, [request, fix].filter(Boolean).join("\n\n")));
        } catch (error) {
          if (error instanceof CallBudgetExceeded) throw error;
          problems = [`the writer's call failed: ${message(error)}`];
          continue;
        }
        const result = sectionFromDraft(draft, section);
        if (result.section) return { written: result.section, draft, problems: [] };
        problems = result.problems;
      }
      return { ...(draft && { draft }), problems };
    };
    // The fact checker reads it next to its pages; a doubted section is rewritten once.
    const ground = async (lesson: PlannedLesson, section: PlannedSection, done: { written: WrittenSection; draft?: SectionDraft }) => {
      if (options.review === false) return { written: done.written, doubts: [] as string[] };
      const check = (w: WrittenSection) => calls.invoke(models.fact_checker, "fact_checker", factCheckPrompt(sources, lesson, section, w, calls.room("fact_checker")));
      const verdict = await check(done.written);
      if (verdict.supported) return { written: done.written, doubts: [] };
      const claims = verdict.unsupported.length > 0 ? verdict.unsupported : ["(the fact checker named no claim)"];
      const room = calls.room("writer");
      try {
        const draft = await calls.invoke(models.writer, "writer", writerPrompt({ input, sources, lesson, section }, room, retryText("writer", "revise", done.draft, claims, room)));
        const result = sectionFromDraft(draft, section);
        if (result.section) {
          const again = await check(result.section);
          return { written: result.section, doubts: again.supported ? [] : again.unsupported };
        }
      } catch (error) {
        if (error instanceof CallBudgetExceeded) throw error;
      }
      return { written: done.written, doubts: claims };
    };

    const taken = new Set<string>();
    const units: Unit[] = [];
    const lessonOf = (id: string) => base.lessons.find((l) => l.id === id)!;
    const plannedOf = (id: string) => lessons.find((l) => l.id === id)!;

    // 2a. Rewrites.
    await mapLimit(plan.rewrite_sections, concurrency, async ({ section: sectionId, instruction }) => {
      const lesson = lessons.find((l) => l.sections.some((s) => s.id === sectionId))!;
      const section = lesson.sections.find((s) => s.id === sectionId)!;
      const current = lessonOf(lesson.id).sections.find((s) => s.id === sectionId)!;
      const request = [
        "THE COURSE OWNER ASKED FOR A CHANGE TO THIS SECTION.",
        `Request: ${instruction}`,
        "Current text of the section (rewrite it: keep what is correct and still fits the request, change what the request asks for):",
        "<current>",
        sectionMarkdown(current),
        "</current>",
        "Return the complete new section.",
      ].join("\n");
      const done = await write(lesson, section, request);
      if (!done.written) {
        warn(`${section.title}: the rewrite failed its checks (${done.problems.join("; ")})`);
        step("write", `Couldn't rewrite ${section.title}`, "rejected", bullets(done.problems));
        return;
      }
      const { written, doubts } = await ground(lesson, section, { written: done.written, ...(done.draft && { draft: done.draft }) });
      const nextId = blockIds(base, section.id, taken);
      const old = [...liveText(current), ...(liveCheck(current) ? [liveCheck(current)!] : [])];
      const at = current.blocks.findIndex((b) => old.includes(b as TextBlock | CheckBlock));
      const { text, check } = blocksOf(base.course_id, written, nextId, liveCheck(current)?.objective);
      // The old blocks are archived, not removed: history shows what changed, and a revert restores them.
      const changes: Change[] = [
        ...old.map((b): Change => ({ op: "archive_node", node_id: b.id })),
        ...[...text, check].map((block, i): Change => ({ op: "insert_block", section_id: section.id, block, at: Math.max(0, at) + i })),
      ];
      units.push({
        changes,
        summary: { kind: "rewrite", title: section.title, lesson: lesson.title, before: sectionMarkdown(current), after: writtenMarkdown(written), ...(doubts.length > 0 && { warnings: doubts }) },
      });
      step("write", `Rewrote ${section.title}`, doubts.length > 0 ? "rejected" : "ok", doubts.length > 0 ? bullets(doubts) : undefined);
    });

    // 2b. New sections in existing lessons (keyed by lesson and title, for new objectives that name them).
    const newSectionIds = new Map<string, string>();
    const sectionIdsTaken = new Set(base.lessons.flatMap((l) => l.sections.map((s) => s.id.split("/").pop()!)));
    for (const ns of plan.new_sections) {
      newSectionIds.set(`${ns.lesson}\u0000${ns.title.trim().toLowerCase()}`, `${ns.lesson}/${uniqueSlug(ns.title, "section", sectionIdsTaken)}`);
    }
    await mapLimit(plan.new_sections, concurrency, async (ns) => {
      const lesson = plannedOf(ns.lesson);
      const section: PlannedSection = { id: newSectionIds.get(`${ns.lesson}\u0000${ns.title.trim().toLowerCase()}`)!, title: ns.title.trim(), pages: ns.pages };
      const context: PlannedLesson = { ...lesson, sections: [...lesson.sections, section] };
      const done = await write(context, section, `THE COURSE OWNER ASKED FOR THIS NEW SECTION. ${ns.instruction}`);
      if (!done.written) {
        warn(`New section "${ns.title}": its draft failed the checks (${done.problems.join("; ")})`);
        step("write", `Couldn't write ${ns.title}`, "rejected", bullets(done.problems));
        return;
      }
      const { written, doubts } = await ground(context, section, { written: done.written, ...(done.draft && { draft: done.draft }) });
      const nextId = blockIds(base, section.id, taken);
      const { text, check } = blocksOf(base.course_id, written, nextId, ns.objectives[0]);
      const node = lessonOf(ns.lesson);
      const at = ns.after === null ? 0 : node.sections.findIndex((s) => s.id === ns.after) + 1;
      units.push({
        changes: [{ op: "add_section", lesson_id: ns.lesson, section: { id: section.id, title: section.title, blocks: [...text, check], archived: false }, at, objectives: ns.objectives }],
        summary: { kind: "new_section", title: section.title, lesson: lesson.title, after: writtenMarkdown(written), ...(doubts.length > 0 && { warnings: doubts }) },
      });
      step("write", `Wrote ${section.title}`, doubts.length > 0 ? "rejected" : "ok", doubts.length > 0 ? bullets(doubts) : undefined);
    });

    // The examiner, for one objective of a lesson; `given` misconceptions keep tags consistent.
    const allWritten = writtenFromSnapshot(base);
    const examine = (lesson: PlannedLesson, k: number, given: AssessmentDraft["misconceptions"] | undefined, extra?: string) =>
      calls.invoke(
        models.examiner,
        "examiner",
        examinerPrompt({ input, lesson, lessons, written: allWritten, evaluated: [], perObjective }, calls.room("examiner"), extra, { objective: k, ...(given && { misconceptions: given }) }),
      );
    const taken_items = new Map<string, Set<string>>();
    const itemIds = (lessonId: string) => {
      if (!taken_items.has(lessonId)) taken_items.set(lessonId, new Set(base.lessons.find((l) => l.id === lessonId)?.quiz.map((q) => q.id) ?? []));
      const set = taken_items.get(lessonId)!;
      return () => {
        for (let n = 1; ; n++) {
          const id = `${lessonId}-q${n}`;
          if (!set.has(id)) {
            set.add(id);
            return id;
          }
        }
      };
    };
    const otherMisconceptions = (lessonId: string) => new Set(base.misconceptions.filter((m) => m.lesson !== lessonId).map((m) => m.id));

    /**
     * Questions for one objective of an existing lesson, tagged with that lesson's misconceptions. The
     * generator's checks run on a one-objective view of the lesson; "every misconception is expressed"
     * is left to the lesson's other questions, and a short pool is fine when adding to one.
     */
    const questionsFor = async (lessonId: string, objective: Objective, extra: string, fullPool: boolean, newSections: Map<string, WrittenSection>) => {
      const lesson = plannedOf(lessonId);
      const existing = base.misconceptions.filter((m) => m.lesson === lessonId);
      if (existing.length < 2) return { problems: ["the lesson has no misconceptions to tag answers with"] };
      // The examiner gets them by number; their names are the ids, so assessmentFromDraft keeps the ids.
      const given = existing.map((m) => ({ name: m.id, belief: m.belief }));
      const view: PlannedLesson = { ...lesson, objectives: [objective] };
      for (const [id, w] of newSections) allWritten.set(id, w);
      let draft: AssessmentDraft | undefined;
      let problems: string[] = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const fix = attempt > 0 ? retryText("examiner", "fix", draft, problems, calls.room("examiner")) : "";
        draft = { ...(await examine(view, 0, given, [extra, fix].filter(Boolean).join("\n\n"))), misconceptions: given };
        const result = assessmentFromDraft(draft, view, { perObjective, takenMisconceptions: otherMisconceptions(lessonId), sentences, added: !fullPool });
        if (result.assessment) {
          const ids = new Map(result.assessment.misconceptions.map((m, i) => [m.id, existing[i]!.id]));
          const nextId = itemIds(lessonId);
          return { items: result.assessment.items.map((q) => shuffleItem(base.course_id, { ...retag(q, ids), id: nextId() })) };
        }
        problems = result.problems;
      }
      return { problems };
    };

    // 2c. New objectives and more questions in existing lessons.
    const writtenNew = new Map<string, WrittenSection>();
    for (const unit of units) {
      for (const c of unit.changes) {
        if (c.op === "add_section") {
          const blocks = c.section.blocks.filter(isTextBlock).map((b) => ({ kind: b.kind, markdown: b.markdown, cites: b.cites ?? [] }));
          writtenNew.set(c.section.id, { blocks, check: { prompt: "", options: [] } });
        }
      }
    }
    await mapLimit(plan.new_objectives, concurrency, async (no) => {
      const objectiveIds = new Set((base.objectives ?? []).map((o) => o.id));
      let n = 1;
      while (objectiveIds.has(`${no.lesson}-o${n}`)) n++;
      const sections = no.sections.map((s) => (s.includes("/") ? s : newSectionIds.get(`${no.lesson}\u0000${s.trim().toLowerCase()}`)!)).filter(Boolean);
      const objective: Objective = { id: `${no.lesson}-o${n}`, lesson: no.lesson, statement: no.statement.trim(), sections };
      const result = await questionsFor(no.lesson, objective, `THE COURSE OWNER ADDED THIS OBJECTIVE: ${objective.statement}`, true, writtenNew);
      if (!result.items) {
        warn(`New objective "${objective.statement}": its questions failed the checks (${result.problems.join("; ")})`);
        step("assess", `Couldn't write questions for "${objective.statement}"`, "rejected", bullets(result.problems));
        return;
      }
      units.push({
        changes: [{ op: "add_items", lesson_id: no.lesson, items: result.items.map((q) => ({ ...q, objective: objective.id })), objective }],
        summary: { kind: "new_questions", title: objective.statement, lesson: plannedOf(no.lesson).title, questions: result.items.length },
      });
      step("assess", `${result.items.length} questions for "${objective.statement}"`);
    });
    await mapLimit(plan.more_questions, concurrency, async (mq) => {
      const objective = (base.objectives ?? []).find((o) => o.id === mq.objective)!;
      const count = Math.min(MAX_MORE_QUESTIONS, Math.max(1, mq.count || 3));
      const result = await questionsFor(objective.lesson, objective, `THE COURSE OWNER ASKED FOR ${count} MORE QUESTIONS for this objective (write ${count}, not more). ${mq.instruction}`, false, writtenNew);
      if (result.items) result.items = result.items.slice(0, count);
      if (!result.items) {
        warn(`More questions for "${objective.statement}" failed the checks (${result.problems.join("; ")})`);
        step("assess", `Couldn't write questions for "${objective.statement}"`, "rejected", bullets(result.problems));
        return;
      }
      units.push({
        changes: [{ op: "add_items", lesson_id: objective.lesson, items: result.items.map((q) => ({ ...q, objective: objective.id })) }],
        summary: { kind: "new_questions", title: objective.statement, lesson: plannedOf(objective.lesson).title, questions: result.items.length },
      });
      step("assess", `${result.items.length} more questions for "${objective.statement}"`);
    });

    // 2d. New lessons: sections, then one examiner call per objective (the first writes the misconceptions).
    const lessonIdsTaken = new Set(base.lessons.map((l) => l.id));
    for (const nl of plan.new_lessons) {
      const id = uniqueSlug(nl.title, "lesson", lessonIdsTaken);
      const sectionTaken = new Set<string>();
      const sections: PlannedSection[] = nl.sections.map((s) => ({ id: `${id}/${uniqueSlug(s.title, "section", sectionTaken)}`, title: s.title.trim(), pages: s.pages }));
      const objectives: Objective[] = nl.objectives.map((o, k) => ({
        id: `${id}-o${k + 1}`,
        lesson: id,
        statement: o.statement.trim(),
        sections: o.sections.map((n) => sections[n - 1]?.id).filter((x): x is string => Boolean(x)),
      }));
      const lesson: PlannedLesson = { id, title: nl.title.trim(), summary: nl.summary.trim(), prerequisites: [...nl.prerequisites], sections, objectives };
      lessons.push(lesson);
      const written = await mapLimit(sections, concurrency, (section) => write(lesson, section, `THE COURSE OWNER ASKED FOR A NEW LESSON, "${lesson.title}". Write this section of it.`));
      const failed = written.flatMap((w, i) => (w.written ? [] : [`${sections[i]!.title}: ${w.problems.join("; ")}`]));
      if (failed.length > 0) {
        warn(`New lesson "${lesson.title}" was left out: ${failed.join("; ")}`);
        step("write", `Couldn't write the lesson ${lesson.title}`, "rejected", bullets(failed));
        continue;
      }
      const grounded = await mapLimit(sections, concurrency, (section, i) => ground(lesson, section, { written: written[i]!.written!, ...(written[i]!.draft && { draft: written[i]!.draft }) }));
      grounded.forEach((g, i) => allWritten.set(sections[i]!.id, g.written));

      let drafts: (AssessmentDraft | undefined)[] = [];
      let assessment: { items: QuizItem[]; misconceptions: MisconceptionDef[] } | undefined;
      let problems: string[] = [];
      for (let attempt = 0; attempt < 2 && !assessment; attempt++) {
        const byPart = attempt > 0 ? problemsByPart(problems, mergeDrafts(drafts as AssessmentDraft[]).owners, objectives.length, id) : undefined;
        const fix = (k: number) => (byPart?.[k]?.length ? retryText("examiner", "fix", drafts[k], byPart[k]!, calls.room("examiner")) : undefined);
        const first = await examine(lesson, 0, undefined, fix(0));
        drafts = [first];
        const rest = await mapLimit(objectives.slice(1), concurrency, (_, i) => examine(lesson, i + 1, first.misconceptions, fix(i + 1)));
        drafts.push(...rest);
        const merged = mergeDrafts(drafts as AssessmentDraft[]);
        const result = assessmentFromDraft({ ...merged.draft, misconceptions: first.misconceptions }, lesson, {
          perObjective,
          takenMisconceptions: new Set(base.misconceptions.map((m) => m.id)),
          sentences,
        });
        if (result.assessment) assessment = result.assessment;
        else problems = result.problems;
      }
      if (!assessment) {
        warn(`New lesson "${lesson.title}" was left out: its exam failed the checks (${problems.slice(0, 5).join("; ")})`);
        step("assess", `Couldn't write the exam for ${lesson.title}`, "rejected", bullets(problems.slice(0, 10)));
        continue;
      }
      const node: LessonNode = {
        id,
        title: lesson.title,
        summary: lesson.summary,
        prerequisites: lesson.prerequisites,
        archived: false,
        exam: { per_objective: perObjective },
        quiz: assessment.items.map((q) => shuffleItem(base.course_id, q)),
        sections: sections.map((section, i) => {
          const nextId = blockIds(base, section.id, taken);
          const objective = objectives.find((o) => o.sections.includes(section.id));
          const { text, check } = blocksOf(base.course_id, grounded[i]!.written, nextId, objective?.id);
          return { id: section.id, title: section.title, blocks: [...text, check], archived: false };
        }),
      };
      const at = nl.after === null ? 0 : base.lessons.findIndex((l) => l.id === nl.after) + 1;
      const doubts = grounded.flatMap((g) => g.doubts);
      units.push({
        changes: [{ op: "add_lesson", lesson: node, objectives, misconceptions: assessment.misconceptions, at }],
        summary: {
          kind: "new_lesson",
          title: lesson.title,
          lesson: lesson.title,
          after: node.sections.map((s) => `**${s.title}**\n\n${s.blocks.filter(isTextBlock).map((b) => b.markdown).join("\n\n")}`).join("\n\n"),
          questions: node.quiz.length,
          ...(doubts.length > 0 && { warnings: doubts }),
        },
      });
      step("assess", `Wrote the lesson ${lesson.title}: ${node.sections.length} sections, ${node.quiz.length} questions`);
    }

    // 3. Validate: each part is applied on top of the ones before; a part that breaks the course is left out.
    // Order: new sections before the objectives and questions that refer to them, lessons last.
    const order = { rewrite: 0, new_section: 1, new_questions: 2, new_lesson: 3 } as const;
    units.sort((a, b) => order[a.summary.kind] - order[b.summary.kind]);
    const baseline = new Set(studioChecks(base, sources).map((p) => p.message));
    let current = base;
    const accepted: Unit[] = [];
    for (const unit of units) {
      try {
        const next = applyChanges(current, unit.changes);
        courseFromSnapshot(next);
        const found = studioChecks(next, sources).filter((p) => !baseline.has(p.message));
        if (found.length > 0) throw new ChangeError(found.map((p) => p.message).join("; "));
        current = next;
        accepted.push(unit);
      } catch (error) {
        warn(`"${unit.summary.title}" was left out: it would break the course (${message(error).split("\n").slice(0, 3).join(" ")})`);
      }
    }
    if (accepted.length === 0) return fail(warnings.length > 0 ? warnings : ["Nothing could be changed"]);
    step("validate", `${accepted.length} change(s) pass the course checks`);

    const proposal: EditProposal = {
      base_version: base.version,
      changes: accepted.flatMap((u) => u.changes),
      summary: accepted.map((u) => u.summary),
      reply: plan.reply,
    };
    step("done", `Proposed ${accepted.length} change(s)`, "ok", `${calls.count} model call(s).`);
    return { ok: true, proposal, warnings, model_calls: calls.count };
  } catch (error) {
    return fail([error instanceof CallBudgetExceeded ? error.message : `The edit stopped: ${message(error)}`]);
  }
}

/** Points an item's misconception tags at the lesson's existing ids. */
function retag(item: QuizItem, ids: ReadonlyMap<string, string>): QuizItem {
  const fix = <T extends { misconception?: string }>(o: T): T => (o.misconception && ids.has(o.misconception) ? { ...o, misconception: ids.get(o.misconception)! } : o);
  const copy = structuredClone(item) as QuizItem & { options?: { misconception?: string }[]; reasons?: { misconception?: string }[]; patterns?: { misconception?: string }[] };
  if (copy.options) copy.options = copy.options.map(fix);
  if (copy.reasons) copy.reasons = copy.reasons.map(fix);
  if (copy.patterns) copy.patterns = copy.patterns.map(fix);
  return copy;
}

/** One entry per rewritten section and per objective getting questions: a model sometimes lists one twice. */
function merged(plan: EditPlanDraft): EditPlanDraft {
  const rewrites = new Map<string, EditPlanDraft["rewrite_sections"][number]>();
  for (const r of plan.rewrite_sections) {
    const seen = rewrites.get(r.section);
    rewrites.set(r.section, seen ? { ...seen, instruction: `${seen.instruction} ${r.instruction}` } : r);
  }
  const more = new Map<string, EditPlanDraft["more_questions"][number]>();
  for (const q of plan.more_questions) {
    const seen = more.get(q.objective);
    more.set(q.objective, seen ? { ...seen, count: seen.count + q.count, instruction: `${seen.instruction} ${q.instruction}` } : q);
  }
  return { ...plan, rewrite_sections: [...rewrites.values()], more_questions: [...more.values()] };
}

function describePlan(plan: EditPlanDraft): string {
  const parts = [
    plan.rewrite_sections.length && `${plan.rewrite_sections.length} rewrite(s)`,
    plan.new_sections.length && `${plan.new_sections.length} new section(s)`,
    plan.new_lessons.length && `${plan.new_lessons.length} new lesson(s)`,
    plan.new_objectives.length && `${plan.new_objectives.length} new objective(s)`,
    plan.more_questions.length && `more questions for ${plan.more_questions.length} objective(s)`,
  ].filter(Boolean);
  return `Planned ${parts.join(", ")}`;
}

/** The editor's user message: the request, the course outline, and what the material's pages hold. */
function editorPrompt(input: BuildInput, snapshot: CourseSnapshot, lessons: readonly PlannedLesson[], material: readonly Source[], request: string, ideas: string, room: number): string {
  const outline = lessons
    .map((l) =>
      [
        `Lesson ${l.id}: ${l.title}${l.prerequisites.length > 0 ? ` (builds on ${l.prerequisites.join(", ")})` : ""}`,
        ...l.objectives.map((o) => `  objective ${o.id}: ${o.statement}`),
        ...l.sections.map((s) => `  section ${s.id}: ${s.title} [${s.pages.map(pageLabel).join(", ")}]`),
      ].join("\n"),
    )
    .join("\n");
  // A page index: each material page's first line, which for slides and chapters is usually its heading.
  const index = material.flatMap((s) =>
    s.pages.map((text, i) => `- [${s.id} p.${i + 1}] ${text.trim().split("\n").find((line) => line.trim())?.trim().slice(0, 90) ?? ""}`),
  );
  const header = [
    `Course: ${input.title}`,
    input.goal && `The owner's goal for learners: ${input.goal}`,
    request,
    `Teaching-material sources: ${material.map((s) => `${s.id} "${s.name}" (pages 1-${s.pages.length})`).join("; ") || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
  const thinned = thinLines(index, Math.floor(room * 0.3));
  return fitParts(
    [
      { text: header },
      { text: outline, elastic: true, before: `The course now (${snapshot.lessons.length} lessons):\n` },
      ...(ideas ? [{ text: ideas, elastic: true, before: "Key ideas of the new file:\n" }] : []),
      { text: thinned.lines.join("\n"), elastic: true, before: "Page index of the teaching material (first line of each page):\n" },
    ],
    room,
  );
}

/** Problems with an edit list, phrased for the editor's retry. Empty = every id, page and count is valid. */
export function checkPlan(plan: EditPlanDraft, snapshot: CourseSnapshot, sources: readonly Source[]): string[] {
  return planIssues(plan, snapshot, sources).map((i) => i.problem);
}

/** The edit list without the entries that have problems. */
function keepValid(plan: EditPlanDraft, snapshot: CourseSnapshot, sources: readonly Source[]): EditPlanDraft {
  const bad = new Set(planIssues(plan, snapshot, sources).map((i) => i.entry));
  return {
    reply: plan.reply,
    rewrite_sections: plan.rewrite_sections.filter((e) => !bad.has(e)),
    new_sections: plan.new_sections.filter((e) => !bad.has(e)),
    new_lessons: plan.new_lessons.filter((e) => !bad.has(e)),
    new_objectives: plan.new_objectives.filter((e) => !bad.has(e)),
    more_questions: plan.more_questions.filter((e) => !bad.has(e)),
  };
}

function planIssues(plan: EditPlanDraft, snapshot: CourseSnapshot, sources: readonly Source[]): { entry: object; problem: string }[] {
  const issues: { entry: object; problem: string }[] = [];
  const live = snapshot.lessons.filter((l) => !l.archived);
  const lessonById = new Map(live.map((l) => [l.id, l]));
  const sectionLesson = new Map(live.flatMap((l) => l.sections.filter((s) => !s.archived).map((s) => [s.id, l.id] as const)));
  const objectives = snapshot.objectives ?? [];
  const pageOk = (p: Citation) => {
    const s = sources.find((x) => x.id === p.source);
    return Boolean(s && s.role === "material" && p.page >= 1 && p.page <= s.pages.length);
  };
  const pages = (entry: object, where: string, list: readonly Citation[]) => {
    if (list.length === 0) issues.push({ entry, problem: `${where}: give at least one teaching-material page` });
    for (const p of list) if (!pageOk(p)) issues.push({ entry, problem: `${where}: ${pageLabel(p)} is not a teaching-material page` });
  };

  for (const e of plan.rewrite_sections) {
    const lessonId = sectionLesson.get(e.section);
    if (!lessonId) issues.push({ entry: e, problem: `rewrite_sections: "${e.section}" is not a section id` });
    else if (sectionPages(lessonById.get(lessonId)!.sections.find((s) => s.id === e.section)!).length === 0) {
      issues.push({ entry: e, problem: `rewrite_sections: "${e.section}" cites no source pages, so it can't be rewritten from them` });
    }
    if (!e.instruction.trim()) issues.push({ entry: e, problem: `rewrite_sections: "${e.section}" needs an instruction` });
  }
  for (const e of plan.new_sections) {
    const lesson = lessonById.get(e.lesson);
    const where = `new_sections "${e.title}"`;
    if (!lesson) {
      issues.push({ entry: e, problem: `${where}: "${e.lesson}" is not a lesson id` });
      continue;
    }
    if (!e.title.trim()) issues.push({ entry: e, problem: `${where}: give it a title` });
    if (e.after !== null && !lesson.sections.some((s) => s.id === e.after)) issues.push({ entry: e, problem: `${where}: "${e.after}" is not a section of ${e.lesson}` });
    for (const o of e.objectives) if (!objectives.some((x) => x.id === o && x.lesson === e.lesson)) issues.push({ entry: e, problem: `${where}: "${o}" is not an objective of ${e.lesson}` });
    pages(e, where, e.pages);
  }
  for (const e of plan.new_lessons) {
    const where = `new_lessons "${e.title}"`;
    const at = e.after === null ? -1 : live.findIndex((l) => l.id === e.after);
    if (e.after !== null && at < 0) issues.push({ entry: e, problem: `${where}: "${e.after}" is not a lesson id` });
    const earlier = new Set(live.slice(0, at + 1).map((l) => l.id));
    for (const p of e.prerequisites) if (!earlier.has(p)) issues.push({ entry: e, problem: `${where}: prerequisite "${p}" must be a lesson up to and including "${e.after}"` });
    if (e.sections.length < 1 || e.sections.length > 4) issues.push({ entry: e, problem: `${where}: give 1 to 4 sections` });
    e.sections.forEach((s, i) => pages(e, `${where}, section ${i + 1}`, s.pages));
    if (e.objectives.length < 1 || e.objectives.length > 4) issues.push({ entry: e, problem: `${where}: give 1 to 4 objectives` });
    for (const o of e.objectives) {
      if (o.sections.length === 0 || o.sections.some((n) => n < 1 || n > e.sections.length)) {
        issues.push({ entry: e, problem: `${where}: objective "${o.statement}" must name sections 1 to ${e.sections.length}` });
      }
    }
  }
  for (const e of plan.new_objectives) {
    const lesson = lessonById.get(e.lesson);
    const where = `new_objectives "${e.statement}"`;
    if (!lesson) {
      issues.push({ entry: e, problem: `${where}: "${e.lesson}" is not a lesson id` });
      continue;
    }
    const added = plan.new_sections.filter((s) => s.lesson === e.lesson).map((s) => s.title.trim().toLowerCase());
    for (const s of e.sections) {
      if (!(sectionLesson.get(s) === e.lesson || added.includes(s.trim().toLowerCase()))) issues.push({ entry: e, problem: `${where}: "${s}" is neither a section of ${e.lesson} nor a new section's title` });
    }
    if (e.sections.length === 0) issues.push({ entry: e, problem: `${where}: name the sections that teach it` });
  }
  for (const e of plan.more_questions) {
    if (!objectives.some((o) => o.id === e.objective)) issues.push({ entry: e, problem: `more_questions: "${e.objective}" is not an objective id` });
  }
  return issues;
}

