import { type AgentName, renderTemplate } from "../agents.js";
import { type CourseSnapshot, courseFromSnapshot } from "../course/compile.js";
import { type Source, SourceSchema } from "../course/sources.js";
import type { StructuredFactory } from "../models.js";
import { assembleSnapshot, shuffleOptions } from "./assemble.js";
import { assessmentFromDraft, examinerPrompt, type LessonAssessment, mergeDrafts, problemsByPart } from "./assess.js";
import { assessmentSentences, routeValidationError, studioChecks } from "./checks.js";
import { type BuilderModels, CallBudgetExceeded, createBuilderModels, ModelCalls } from "./models.js";
import { type CoursePlan, DEFAULT_PLAN_LIMITS, describePlan, type PlanLimits, type PlannedLesson, type PlannedSection, planFromDraft, plannerPrompt } from "./plan.js";
import { mapLimit } from "./prompt.js";
import { factCheckPrompt } from "./review.js";
import type { AssessmentDraft, SectionDraft } from "./schemas.js";
import { classifySource, digestSource, type SourceDigest } from "./sources.js";
import { stressTest } from "./stress.js";
import type { BuildInput, BuildReport, BuildResult, BuildStep } from "./types.js";
import { sectionFromDraft, type WrittenSection, writerPrompt } from "./write.js";

// Course generation: owner's documents in, a validated v1.0.0 snapshot out. Classify → digest → plan →
// write → assess → validate (fix rounds) → review grounding → stress test. Each step's model output is
// checked in code; problems go back to the step that produced them a bounded number of times, and a
// course that still breaks a rule is not returned. No state is kept between calls (see types.ts).

/** Characters of input any one model call may get (system prompt included). */
export const DEFAULT_MAX_CHARS = 24_000;
/** Model calls one build may make, fix rounds and retries included. */
export const DEFAULT_MAX_CALLS = 400;
/** Validate → fix rounds before a build gives up; also bounds plan attempts. */
export const MAX_FIX_ROUNDS = 3;

export interface BuildOptions {
  onStep?: (step: BuildStep) => void;
  maxChars?: number;
  maxCalls?: number;
  /** Exam items per objective (ExamConfig.per_objective). Default 2: with one, a single slip fails a short exam. */
  perObjective?: number;
  limits?: Partial<PlanLimits>;
  /** Fact-check every section with a model (default true). */
  review?: boolean;
  /** Run the missing-prerequisite stress test (default true). */
  stress?: boolean;
  /** Model calls in flight at once (default 4). */
  concurrency?: number;
}

/** What a build step produced, kept for the next round: its value if it passed, its raw draft for a fix. */
interface Unit<T, D> {
  value?: T;
  draft?: D;
  problems: string[];
  warnings: string[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const bullets = (lines: readonly string[]) => lines.map((line) => `- ${line}`).join("\n");

function checkInput(input: BuildInput): string[] {
  const problems: string[] = [];
  if (!input.course_id.trim()) problems.push("The course needs an id");
  if (!input.title.trim()) problems.push("The course needs a title");
  if (input.sources.length === 0) problems.push("Add at least one document to build from");
  const ids = new Set<string>();
  for (const source of input.sources) {
    const parsed = SourceSchema.safeParse(source);
    if (!parsed.success) problems.push(`Source "${source.name ?? source.id}" is malformed: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    if (ids.has(source.id)) problems.push(`Two sources share the id "${source.id}"`);
    ids.add(source.id);
  }
  return problems;
}

/** The fix request sent back to an agent: its previous draft (shortened) and every problem found. */
export function retryText(agent: AgentName, template: string, draft: unknown, problems: readonly string[], room: number): string {
  const max = Math.floor(room / 3);
  let json = draft === undefined ? "(none: the previous call failed)" : JSON.stringify(draft);
  if (json.length > max) json = `${json.slice(0, max - 1)}…`;
  const listed = problems.slice(0, 30).map((p) => (p.length > 300 ? `${p.slice(0, 299)}…` : p));
  return renderTemplate(agent, template, { draft: json, problems: bullets(listed) });
}

export async function buildCourse(input: BuildInput, models: BuilderModels, options: BuildOptions = {}): Promise<BuildResult> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const perObjective = options.perObjective ?? 2;
  let limits: PlanLimits = { ...DEFAULT_PLAN_LIMITS, ...options.limits };
  const concurrency = options.concurrency ?? 4;
  const calls = new ModelCalls(maxChars, options.maxCalls ?? DEFAULT_MAX_CALLS);
  const report: BuildReport = { steps: [], model_calls: 0, warnings: [] };

  const step = (stage: BuildStep["stage"], title: string, status: BuildStep["status"] = "ok", detail?: string) => {
    const entry: BuildStep = { stage, title, status, at: new Date().toISOString(), ...(detail && { detail }) };
    report.steps.push(entry);
    options.onStep?.(entry);
  };
  const warn = (warning: string) => {
    if (!report.warnings.includes(warning)) report.warnings.push(warning);
  };
  const fail = (problems: string[]): BuildResult => {
    step("done", "The course was not built", "rejected", bullets(problems.slice(0, 20)));
    report.model_calls = calls.count;
    return { ok: false, problems, report };
  };

  try {
    const inputProblems = checkInput(input);
    if (inputProblems.length > 0) return fail(inputProblems);

    // 1. Classify.
    const sources: (Source & { role: NonNullable<Source["role"]> })[] = [];
    for (const original of input.sources) {
      const { source, how } = await classifySource(original, models, calls);
      sources.push(source);
      step("classify", `${source.name}: ${source.role}`, "ok", `Decided by ${how}.`);
    }
    if (!sources.some((s) => s.role === "material")) {
      return fail(["No teaching material: every document was classified as an assessment or a brief. Mark at least one as material."]);
    }

    // 2. Digest.
    const digests: SourceDigest[] = await mapLimit(sources, concurrency, async (source) => {
      const { digest, calls: n, copied } = await digestSource(source, models, calls);
      const dropped = copied > 0 ? ` ${copied} point(s) that copied the document's wording were dropped.` : "";
      step("digest", `Read ${source.name}`, "ok", `${source.pages.length} page(s) in ${n} call(s): ${digest.points.length} point(s).${dropped}`);
      return digest;
    });
    if (!digests.some((d) => d.source.role === "material" && d.points.length > 0)) {
      return fail(["No key ideas could be read from the teaching material (are the pages empty or images only?)."]);
    }
    const evaluated = digests.filter((d) => d.source.role !== "material");
    // A two-page handout can't make three lessons: never ask for more lessons than there are material pages.
    const materialPages = sources.filter((s) => s.role === "material").reduce((n, s) => n + s.pages.filter((p) => p.trim()).length, 0);
    if (materialPages < limits.minLessons) {
      limits = { ...limits, minLessons: Math.max(1, materialPages) };
      warn(`The material has only ${materialPages} page(s), so the course may have fewer than ${DEFAULT_PLAN_LIMITS.minLessons} lessons`);
    }

    // 3. Plan.
    let plan: CoursePlan | undefined;
    let planProblems: string[] = [];
    let planDraft: unknown;
    for (let attempt = 0; attempt <= MAX_FIX_ROUNDS && !plan; attempt++) {
      const room = calls.room("planner");
      const retry = attempt > 0 ? retryText("planner", "fix", planDraft, planProblems, room) : "";
      const { prompt, dropped } = plannerPrompt(input, digests, limits, room - retry.length - 2);
      if (dropped > 0 && attempt === 0) warn(`The plan saw a sample of the material's key ideas (${dropped} left out to fit the model's input limit)`);
      const draft = await calls.invoke(models.planner, "planner", retry ? `${prompt}\n\n${retry}` : prompt);
      planDraft = draft;
      const result = planFromDraft(draft, sources, limits);
      if (result.problems.length === 0) {
        plan = result.plan;
        result.warnings.forEach(warn);
      } else {
        planProblems = result.problems;
        step("plan", `Plan rejected (attempt ${attempt + 1})`, "rejected", bullets(planProblems));
      }
    }
    if (!plan) return fail(planProblems.map((p) => `Plan: ${p}`));
    const sectionCount = plan.lessons.reduce((n, l) => n + l.sections.length, 0);
    step("plan", `Planned ${plan.lessons.length} lessons, ${sectionCount} sections`, "ok", describePlan(plan));
    const lessons = plan.lessons;
    const allSections = lessons.flatMap((lesson) => lesson.sections.map((section) => ({ lesson, section })));

    // 4. Write.
    const sectionUnits = new Map<string, Unit<WrittenSection, SectionDraft>>();
    const written = () => new Map([...sectionUnits].flatMap(([id, u]) => (u.value ? [[id, u.value] as const] : [])));
    const writeSection = async (lesson: PlannedLesson, section: PlannedSection, retry?: { template: "fix" | "revise"; problems: string[] }) => {
      const room = calls.room("writer");
      const previous = sectionUnits.get(section.id);
      const extra = retry && retryText("writer", retry.template, previous?.draft, retry.problems, room);
      let unit: Unit<WrittenSection, SectionDraft>;
      try {
        const draft = await calls.invoke(models.writer, "writer", writerPrompt({ input, sources, lesson, section }, room, extra));
        const result = sectionFromDraft(draft, section);
        unit = { ...(result.section && { value: result.section }), draft, problems: result.problems, warnings: [] };
      } catch (error) {
        if (error instanceof CallBudgetExceeded) throw error;
        unit = { problems: [`the writer's call failed: ${message(error)}`], warnings: [] };
      }
      step("write", `${unit.value ? "Wrote" : "Rejected"} ${section.id}`, unit.value ? "ok" : "rejected", unit.problems.length > 0 ? bullets(unit.problems) : undefined);
      return unit;
    };
    await mapLimit(allSections, concurrency, async ({ lesson, section }) => {
      sectionUnits.set(section.id, await writeSection(lesson, section));
    });

    // 5. Assess: one examiner call per objective; the first also writes the lesson's misconceptions.
    const sentences = assessmentSentences(sources);
    const lessonUnits = new Map<string, Unit<LessonAssessment, AssessmentDraft>>();
    /** Per lesson: each objective's latest draft, and which call wrote each question of the merged pool. */
    const examParts = new Map<string, { drafts: (AssessmentDraft | undefined)[]; owners: number[] }>();
    const assessLesson = async (lesson: PlannedLesson, problems?: string[]) => {
      const parts = lesson.objectives.length;
      const previous = examParts.get(lesson.id);
      const byPart = problems && previous ? problemsByPart(problems, previous.owners, parts, lesson.id) : undefined;
      const drafts = previous ? [...previous.drafts] : Array.from({ length: parts }, (): AssessmentDraft | undefined => undefined);
      const failed: string[] = [];
      const context = { input, lesson, lessons, written: written(), evaluated, perObjective };
      const examine = async (k: number, misconceptions?: AssessmentDraft["misconceptions"]) => {
        const room = calls.room("examiner");
        const fix = byPart?.[k] ?? [];
        const extra = fix.length > 0 ? retryText("examiner", "fix", drafts[k], fix, room) : undefined;
        try {
          drafts[k] = await calls.invoke(models.examiner, "examiner", examinerPrompt(context, room, extra, { objective: k, ...(misconceptions && { misconceptions }) }));
        } catch (error) {
          if (error instanceof CallBudgetExceeded) throw error;
          drafts[k] = undefined;
          // Phrased so a retry goes to this objective's call only (see problemsByPart).
          failed.push(`objective ${k + 1} has no questions: the examiner's call failed: ${message(error)}`);
        }
      };
      // New misconceptions mean every call's tags are stale, so all calls are made again. Otherwise only
      // the calls with problems are, and the first keeps the misconceptions the others were given.
      const fresh = !byPart || !drafts[0] || byPart[0]!.some((p) => /^write \d+ to \d+ misconceptions|^misconception \d+ states no belief/.test(p));
      let misconceptions = fresh ? undefined : drafts[0]!.misconceptions;
      if (fresh) {
        await examine(0);
        misconceptions = drafts[0]?.misconceptions;
      }
      const todo = Array.from({ length: parts }, (_, k) => k).filter((k) => (fresh ? k > 0 : !drafts[k] || byPart![k]!.length > 0));
      if (drafts[0]) await mapLimit(todo, concurrency, (k) => examine(k, misconceptions));
      if (!fresh && drafts[0] && misconceptions) drafts[0] = { ...drafts[0], misconceptions };

      let unit: Unit<LessonAssessment, AssessmentDraft>;
      if (failed.length > 0 || drafts.some((d) => !d)) {
        examParts.set(lesson.id, { drafts, owners: previous?.owners ?? [] });
        unit = { problems: failed.length > 0 ? failed : ["the examiner wrote no misconceptions, so the other objectives weren't examined"], warnings: [] };
      } else {
        const merged = mergeDrafts(drafts as AssessmentDraft[]);
        examParts.set(lesson.id, { drafts, owners: merged.owners });
        // Misconception ids must be unique across lessons: taken = the other lessons' current ones.
        const takenMisconceptions = new Set(
          [...lessonUnits].flatMap(([id, u]) => (id === lesson.id ? [] : (u.value?.misconceptions ?? []).map((m) => m.id))),
        );
        const result = assessmentFromDraft(merged.draft, lesson, { perObjective, takenMisconceptions, sentences });
        unit = { ...(result.assessment && { value: result.assessment }), draft: merged.draft, problems: result.problems, warnings: result.warnings };
      }
      // Set before any other conversion can run, so the next lesson sees these misconception ids as taken.
      lessonUnits.set(lesson.id, unit);
      const what = unit.value ? `${unit.value.items.length} questions, ${unit.value.misconceptions.length} misconceptions` : "";
      step("assess", `${unit.value ? "Assessed" : "Rejected"} ${lesson.id}${what && `: ${what}`}`, unit.value ? "ok" : "rejected", unit.problems.length > 0 ? bullets(unit.problems) : undefined);
    };
    await mapLimit(lessons, concurrency, (lesson) => assessLesson(lesson));

    // 6. Validate, sending problems back to the step that produced them.
    const assemble = () =>
      assembleSnapshot(
        { id: input.course_id, title: input.title },
        plan!,
        written(),
        new Map([...lessonUnits].flatMap(([id, u]) => (u.value ? [[id, u.value] as const] : []))),
        perObjective,
      );
    /** Whole-course checks, each problem attributed to a section, a lesson, or (unattributed) the course. */
    const gate = (snapshot: CourseSnapshot) => {
      const found: { section?: string; lesson?: string; message: string }[] = studioChecks(snapshot, sources).map((p) =>
        p.section ? { section: p.section, message: p.message } : p.lesson ? { lesson: p.lesson, message: p.message } : { message: p.message },
      );
      try {
        courseFromSnapshot(snapshot);
      } catch (error) {
        found.push(...routeValidationError(snapshot, message(error)));
      }
      return found;
    };

    let snapshot: CourseSnapshot | undefined;
    for (let round = 1; !snapshot; round++) {
      const failedSections = allSections.filter(({ section }) => (sectionUnits.get(section.id)?.problems.length ?? 1) > 0);
      const failedLessons = lessons.filter((l) => (lessonUnits.get(l.id)?.problems.length ?? 1) > 0);
      const courseProblems: string[] = [];
      if (failedSections.length === 0 && failedLessons.length === 0) {
        const candidate = assemble();
        const found = gate(candidate);
        if (found.length === 0) {
          snapshot = candidate;
          step("validate", "The course passes validation", "ok", round > 1 ? `After ${round - 1} fix round(s).` : undefined);
          break;
        }
        for (const p of found) {
          if (p.section) sectionUnits.get(p.section)?.problems.push(p.message);
          else if (p.lesson) lessonUnits.get(p.lesson)?.problems.push(p.message);
          else courseProblems.push(p.message);
        }
        failedSections.push(...allSections.filter(({ section }) => found.some((p) => p.section === section.id)));
        failedLessons.push(...lessons.filter((l) => found.some((p) => p.lesson === l.id)));
      }
      const all = [
        ...failedSections.flatMap(({ section }) => sectionUnits.get(section.id)!.problems.map((p) => `Section ${section.id}: ${p}`)),
        ...failedLessons.flatMap((l) => lessonUnits.get(l.id)!.problems.map((p) => `Lesson ${l.id}: ${p}`)),
        ...courseProblems,
      ];
      step("validate", `Validation round ${round}: ${all.length} problem(s)`, "rejected", bullets(all.slice(0, 20)));
      // Nothing to send back means no step can fix it.
      if (round > MAX_FIX_ROUNDS || (failedSections.length === 0 && failedLessons.length === 0)) return fail(all);

      await mapLimit(failedSections, concurrency, async ({ lesson, section }) => {
        const problems = sectionUnits.get(section.id)!.problems;
        sectionUnits.set(section.id, { ...(await writeSection(lesson, section, { template: "fix", problems })) });
      });
      await mapLimit(failedLessons, concurrency, (lesson) => assessLesson(lesson, lessonUnits.get(lesson.id)!.problems));
    }
    for (const unit of lessonUnits.values()) unit.warnings.forEach(warn);

    // 7. Review grounding with a model; a section it doubts is rewritten once.
    if (options.review !== false) {
      const before = new Map(written());
      const rewritten: string[] = [];
      const factCheck = (lesson: PlannedLesson, section: PlannedSection, text: WrittenSection) =>
        calls.invoke(models.fact_checker, "fact_checker", factCheckPrompt(sources, lesson, section, text, calls.room("fact_checker")));
      await mapLimit(allSections, concurrency, async ({ lesson, section }) => {
        const original = before.get(section.id)!;
        let verdict;
        try {
          verdict = await factCheck(lesson, section, original);
        } catch (error) {
          if (error instanceof CallBudgetExceeded) throw error;
          warn(`Section ${section.id} was not fact-checked: ${message(error)}`);
          return;
        }
        if (verdict.supported) {
          step("review", `Grounded: ${section.id}`);
          return;
        }
        const claims = verdict.unsupported.length > 0 ? verdict.unsupported : ["(the fact checker named no claim)"];
        const unit = await writeSection(lesson, section, { template: "revise", problems: claims });
        if (!unit.value) {
          sectionUnits.set(section.id, { value: original, problems: [], warnings: [] });
          warn(`Section ${section.id} may state things its pages don't support; its rewrite failed code checks, so the original is kept: ${claims.join("; ")}`);
          step("review", `Weak grounding kept: ${section.id}`, "rejected", bullets(claims));
          return;
        }
        sectionUnits.set(section.id, unit);
        rewritten.push(section.id);
        const again = await factCheck(lesson, section, unit.value).catch((error: unknown) => {
          if (error instanceof CallBudgetExceeded) throw error;
          return undefined;
        });
        if (again?.supported) step("review", `Rewritten and grounded: ${section.id}`, "ok", bullets(claims));
        else {
          warn(`Section ${section.id} may state things its pages don't support, even after a rewrite: ${(again?.unsupported ?? claims).join("; ")}`);
          step("review", `Weak grounding: ${section.id}`, "rejected", bullets(again?.unsupported ?? claims));
        }
      });
      if (rewritten.length > 0) {
        const candidate = assemble();
        if (gate(candidate).length === 0) snapshot = candidate;
        else {
          // A rewrite broke a whole-course rule: go back to the validated text for those sections.
          for (const id of rewritten) sectionUnits.set(id, { value: before.get(id)!, problems: [], warnings: [] });
          warn(`Rewrites after the fact check broke validation, so ${rewritten.join(", ")} keep their first text`);
        }
      }
    }

    // 8. Stress test.
    if (options.stress !== false) {
      try {
        const result = stressTest(snapshot);
        const status = result.outcome === "detected" ? "ok" : result.outcome === "missed" ? "rejected" : "info";
        step("stress", result.outcome === "skipped" ? "Stress test skipped" : `Missing prerequisite ${result.outcome}`, status, result.detail);
        if (result.outcome === "missed") warn(`Stress test: ${result.detail}`);
      } catch (error) {
        warn(`The stress test could not run: ${message(error)}`);
      }
    }

    const items = snapshot.lessons.reduce((n, l) => n + l.quiz.length, 0);
    step("done", `Built ${snapshot.lessons.length} lessons, ${sectionCount} sections, ${items} questions`, "ok", `${calls.count} model call(s).`);
    report.model_calls = calls.count;
    return { ok: true, snapshot: shuffleOptions(snapshot), report };
  } catch (error) {
    return fail([error instanceof CallBudgetExceeded ? error.message : `Generation stopped: ${message(error)}`]);
  }
}

/** The shape the app's CourseBuilder expects: a structured-output factory (the owner's key) instead of models. */
export function generateCourse(
  input: BuildInput,
  structured: StructuredFactory,
  onStep?: (step: BuildStep) => void,
  options: Omit<BuildOptions, "onStep"> = {},
): Promise<BuildResult> {
  return buildCourse(input, createBuilderModels(structured), { ...options, ...(onStep && { onStep }) });
}
