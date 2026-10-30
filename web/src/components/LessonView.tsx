import { marked } from "marked";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { interventionTracker, useLessonTimer } from "../tracking.js";
import type { Block, Call, Certainty, CheckResult, CourseSnapshot, Exam, Intervention, QuizItem, QuizResult, Response } from "../types.js";
import { InterventionView } from "./Interventions.js";
import { QuizFlow } from "./Quiz.js";

// Lesson Markdown is authored course content (agents can't write Markdown blocks, only templated
// interventions, which render as plain text), so it is rendered as HTML.
const html = (markdown: string) => ({ __html: marked.parse(markdown, { async: false }) as string });

const TEMPLATE_NAME = { contrast: "Contrast card", practice: "Practice set", step_through: "Step-through player" } as const;

type CheckBlock = Extract<Block, { kind: "check" }>;

/**
 * A practice question inside a section. A learner's answer goes to the server, which records it and
 * says why; in a preview (nothing is published yet) the option's own feedback is shown.
 */
function CheckView({ block, call, live }: { block: CheckBlock; call: Call; live: boolean }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function pick(i: number) {
    setPicked(i);
    setError(null);
    const option = block.check.options[i]!;
    if (!live) return setResult({ correct: option.correct, feedback: option.feedback });
    try {
      setResult(await call<CheckResult>("answerCheck", [block.id, i]));
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="block check">
      <div className="check-label small">Practice</div>
      <div className="prompt">{block.check.prompt}</div>
      <div className="options" role="radiogroup">
        {block.check.options.map((o, i) => (
          <button key={i} className={`option ${picked === i ? "picked" : ""}`} role="radio" aria-checked={picked === i} onClick={() => void pick(i)}>
            <span className="mark" aria-hidden />
            <span>{o.text}</span>
          </button>
        ))}
      </div>
      {result && (
        <div className={`check-feedback ${result.correct ? "right" : "wrong"}`} role="status">
          <strong>{result.correct ? "Right." : "Not quite."}</strong> {result.feedback}
        </div>
      )}
      {error && <div className="notice">{error}</div>}
    </div>
  );
}

function BlockView({ block, isNew, belief, preview, live, call }: { block: Block; isNew: boolean; belief: string; preview: boolean; live: boolean; call: Call }) {
  const [open, setOpen] = useState(preview);
  const track = useMemo(() => interventionTracker(call, block.id, "preview"), [call, block.id]);
  if (block.kind === "check") return <CheckView block={block} call={call} live={live} />;
  if (block.kind !== "intervention") {
    return <div className={`block prose ${isNew ? "new" : ""} ${block.archived ? "archived" : ""}`} dangerouslySetInnerHTML={html(block.markdown)} />;
  }
  return (
    <div className={`block ${isNew ? "new" : ""} ${block.archived ? "archived" : ""}`}>
      <div className="slot">
        <span className="chip violet">{TEMPLATE_NAME[block.intervention.template]}</span>
        <div className="grow">
          <div className="who">Only for learners who think: “{belief}”</div>
        </div>
        <button className="btn quiet sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide" : "Preview"}
        </button>
      </div>
      {open && (
        <div className="slot-preview">
          <InterventionView intervention={block.intervention} {...(!preview && { track })} />
        </div>
      )}
    </div>
  );
}

function PathIntervention({ blockId, intervention, call }: { blockId: string; intervention: Intervention; call: Call }) {
  const track = useMemo(() => interventionTracker(call, blockId, "path"), [call, blockId]);
  return <InterventionView intervention={intervention} track={track} />;
}

function Result({
  result,
  snapshot,
  beliefOf,
  onRetake,
  onOpenLesson,
  onOpenSection,
  nextLesson,
  call,
}: {
  call: Call;
  result: QuizResult;
  snapshot: CourseSnapshot;
  beliefOf: (id: string) => string;
  onRetake: () => void;
  onOpenLesson: (id: string) => void;
  onOpenSection: (lesson: string, section: string) => void;
  nextLesson: { id: string; title: string } | null;
}) {
  const scored = result.items.filter((i) => !i.pilot && !i.grade.needs_review);
  const help = result.steps.filter((s) => s.kind === "intervention" || s.kind === "review" || s.kind === "review_section");
  const sectionTitle = (lesson: string, id: string) => snapshot.lessons.find((l) => l.id === lesson)?.sections.find((s) => s.id === id)?.title ?? id;
  return (
    <>
      <div className={`result ${result.passed ? "pass" : "fail"}`}>
        <h3>{result.passed ? "You've got it" : "Not quite yet"}</h3>
        <div className="small">
          {scored.filter((i) => i.grade.correct).length} of {scored.length} right · {Math.round(result.score * 100)}% · mastery estimate{" "}
          {Math.round(result.mastery * 100)}%
        </div>
        <div className="score-dots" aria-hidden>
          {scored.map((i) => (
            <span key={i.item_id} className={i.grade.correct ? "right" : "wrong"} />
          ))}
        </div>
        <div className="row" style={{ marginTop: "var(--s4)" }}>
          {result.passed && nextLesson ? (
            <button className="btn primary" onClick={() => onOpenLesson(nextLesson.id)}>
              Next: {nextLesson.title} →
            </button>
          ) : null}
          <button className={`btn ${result.passed ? "quiet" : help.length > 0 ? "secondary" : "primary"}`} onClick={onRetake}>
            Retake the quiz
          </button>
        </div>
      </div>

      {!result.passed && help.length > 0 && (
        <div className="next-steps">
          <div className="small muted">Before you retake it:</div>
          {result.steps.map((step, i) => {
            if (step.kind === "intervention") {
              const item = result.interventions.find((x) => x.block_id === step.block_id);
              if (!item) return null;
              return (
                <div key={i}>
                  <div className="for-you">
                    <span className="chip violet">For you</span>
                    Some answers suggest you think: “{beliefOf(step.misconception)}”
                  </div>
                  <PathIntervention blockId={item.block_id} intervention={item.intervention} call={call} />
                </div>
              );
            }
            if (step.kind === "review_section") {
              const objective = snapshot.objectives?.find((o) => o.id === step.objective);
              return (
                <div key={i} className="card soft row between">
                  <span className="small">
                    You missed: <strong>{objective?.statement ?? step.objective}</strong>
                  </span>
                  <button className="btn secondary sm" onClick={() => onOpenSection(step.lesson, step.section_id)}>
                    Review §{sectionTitle(step.lesson, step.section_id)}
                  </button>
                </div>
              );
            }
            if (step.kind === "review") {
              return (
                <div key={i} className="card soft row between">
                  <span className="small">Some answers point back to an earlier lesson.</span>
                  <button className="btn secondary sm" onClick={() => onOpenLesson(step.lesson)}>
                    Review {snapshot.lessons.find((l) => l.id === step.lesson)?.title ?? step.lesson}
                  </button>
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </>
  );
}

/**
 * One lesson. `learn`: the learner's view, with checks and the exam. `history`: an earlier release, read
 * only, with archived blocks. `preview`: the owner's look at a built course before it is published.
 */
export function LessonView(props: {
  snapshot: CourseSnapshot;
  parent: CourseSnapshot | null;
  lessonId: string;
  mode: "learn" | "history" | "preview";
  onBackToLive: () => void;
  approvalWaiting: string | null;
  onReviewApproval: () => void;
  call: Call;
  onAnswered: () => void;
  onOpenLesson: (id: string) => void;
  onOpenSection?: (lesson: string, section: string) => void;
  /** Controls shown under each section's title (e.g. "Tune" for people who may edit the course). */
  sectionTools?: (section: { id: string; title: string }) => ReactNode;
}) {
  const { snapshot, parent, lessonId, mode, call } = props;
  const viewingHistory = mode === "history";
  const learning = mode === "learn";
  const lessons = snapshot.lessons.filter((l) => !l.archived);
  const lesson = lessons.find((l) => l.id === lessonId) ?? lessons[0]!;
  const index = lessons.indexOf(lesson);
  const next = lessons[index + 1];
  const [result, setResult] = useState<QuizResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLessonTimer(lesson.id, call, learning);

  // A lesson with an exam config shows a draw from its pool (different questions on a retake); one
  // without shows its whole quiz, as the featured course always has.
  const drawn = Boolean(lesson.exam);
  const [exam, setExam] = useState<Exam | null>(null);
  useEffect(() => {
    if (!learning || !drawn) return;
    setExam(null);
    call<Exam>("exam", [lesson.id])
      .then(setExam)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [call, learning, drawn, lesson.id, attempt]);
  const questions: QuizItem[] | null = drawn ? (exam?.items ?? null) : lesson.quiz;
  const beliefOf = (id: string) => snapshot.misconceptions.find((m) => m.id === id)?.belief ?? id;
  // Blocks that are new in this release, compared with the release it was built on.
  const parentBlocks = useMemo(
    () => (parent ? new Set(parent.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks.map((b) => b.id)))) : null),
    [parent],
  );

  async function submit(answers: Response[], certainty: Certainty[]) {
    setBusy(true);
    setError(null);
    try {
      const args: unknown[] = [lesson.id, answers, certainty];
      if (drawn && questions) args.push(questions.map((q) => q.id));
      setResult(await call<QuizResult>("submitQuiz", args));
      props.onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="lesson">
      {props.approvalWaiting && (
        <div className="notice approval">
          <span className="grow">
            <strong>v{props.approvalWaiting}</strong> is waiting for your approval.
          </span>
          <button className="btn primary sm" onClick={props.onReviewApproval}>
            Review
          </button>
        </div>
      )}
      {viewingHistory && (
        <div className="notice">
          <span className="grow">
            Viewing <strong>v{snapshot.version}</strong>
            {parent ? `: marked blocks are new since v${parent.version}` : ""}.
          </span>
          <button className="btn secondary sm" onClick={props.onBackToLive}>
            Back to live
          </button>
        </div>
      )}

      <div className="crumbs">
        <span>{snapshot.title}</span>
        <span aria-hidden>/</span>
        <span>
          Lesson {index + 1} of {lessons.length}
        </span>
      </div>
      <h1>{lesson.title}</h1>
      <p className="lede">{lesson.summary}</p>
      {lesson.prerequisites.length > 0 && (
        <div className="row small prereqs">
          <span className="muted">Builds on</span>
          {lesson.prerequisites.map((id) => (
            <button key={id} className="chip" onClick={() => props.onOpenLesson(id)}>
              {snapshot.lessons.find((l) => l.id === id)?.title ?? id}
            </button>
          ))}
        </div>
      )}

      {lesson.sections
        .filter((s) => !s.archived || viewingHistory)
        .map((section) => (
          <section key={section.id} id={section.id} className="section">
            {section.title && <h2>{section.title}</h2>}
            {!viewingHistory && props.sectionTools?.(section)}
            {section.blocks
              .filter((b) => !b.archived || viewingHistory)
              .map((block) => (
                <BlockView
                  key={block.id}
                  block={block}
                  isNew={parentBlocks !== null && !parentBlocks.has(block.id)}
                  belief={block.kind === "intervention" ? beliefOf(block.intervention.targets) : ""}
                  preview={!learning}
                  live={learning}
                  call={call}
                />
              ))}
          </section>
        ))}

      {mode === "preview" && (
        <section className="quiz" aria-label="Exam">
          <div className="quiz-top">
            <h2>Exam</h2>
          </div>
          <p className="small muted">
            {lesson.exam
              ? `${lesson.quiz.length} questions in the pool; each attempt draws ${lesson.exam.per_objective} per objective, unseen ones first.`
              : `${lesson.quiz.length} questions, all shown on every attempt.`}
          </p>
        </section>
      )}

      {learning && (
        <section className="quiz" aria-label="Quiz">
          <div className="quiz-top">
            <h2>Check your understanding</h2>
            <span className="small muted">{drawn ? "Pass at 75%, with every objective shown" : "Pass at 75%"}</span>
          </div>
          {error && <div className="notice">{error}</div>}
          {result ? (
            <Result
              result={result}
              call={call}
              snapshot={snapshot}
              beliefOf={beliefOf}
              nextLesson={next ? { id: next.id, title: next.title } : null}
              onOpenLesson={props.onOpenLesson}
              onOpenSection={props.onOpenSection ?? ((lessonId) => props.onOpenLesson(lessonId))}
              onRetake={() => {
                setResult(null);
                setAttempt((a) => a + 1);
              }}
            />
          ) : questions ? (
            // A new attempt, or a release that changes the questions, starts the quiz fresh.
            <QuizFlow key={`${attempt}:${questions.map((q) => q.id).join()}`} quiz={questions} busy={busy} onSubmit={submit} />
          ) : (
            !error && <div className="small muted">Drawing your questions…</div>
          )}
        </section>
      )}
    </article>
  );
}
