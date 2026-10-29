import { marked } from "marked";
import { useMemo, useState } from "react";
import type { Block, Call, Certainty, CourseSnapshot, QuizResult, Response } from "../types.js";
import { InterventionView } from "./Interventions.js";
import { QuizFlow } from "./Quiz.js";

// Lesson Markdown is authored course content (agents can't write Markdown blocks, only templated
// interventions, which render as plain text), so it is rendered as HTML.
const html = (markdown: string) => ({ __html: marked.parse(markdown, { async: false }) as string });

const TEMPLATE_NAME = { contrast: "Contrast card", practice: "Practice set", step_through: "Step-through player" } as const;

function BlockView({ block, isNew, belief, preview }: { block: Block; isNew: boolean; belief: string; preview: boolean }) {
  const [open, setOpen] = useState(preview);
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
          <InterventionView intervention={block.intervention} />
        </div>
      )}
    </div>
  );
}

function Result({
  result,
  snapshot,
  beliefOf,
  onRetake,
  onOpenLesson,
  nextLesson,
}: {
  result: QuizResult;
  snapshot: CourseSnapshot;
  beliefOf: (id: string) => string;
  onRetake: () => void;
  onOpenLesson: (id: string) => void;
  nextLesson: { id: string; title: string } | null;
}) {
  const scored = result.items.filter((i) => !i.pilot && !i.grade.needs_review);
  const help = result.steps.filter((s) => s.kind === "intervention" || s.kind === "review");
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
                  <InterventionView intervention={item.intervention} />
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

export function LessonView(props: {
  snapshot: CourseSnapshot;
  parent: CourseSnapshot | null;
  lessonId: string;
  viewingHistory: boolean;
  onBackToLive: () => void;
  approvalWaiting: string | null;
  onReviewApproval: () => void;
  learner: string;
  call: Call;
  onAnswered: () => void;
  onOpenLesson: (id: string) => void;
}) {
  const { snapshot, parent, lessonId, viewingHistory, learner, call } = props;
  const lessons = snapshot.lessons.filter((l) => !l.archived);
  const lesson = lessons.find((l) => l.id === lessonId) ?? lessons[0]!;
  const index = lessons.indexOf(lesson);
  const next = lessons[index + 1];
  const [result, setResult] = useState<QuizResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      setResult(await call<QuizResult>("submitQuiz", [learner, lesson.id, answers, certainty]));
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
            {section.blocks
              .filter((b) => !b.archived || viewingHistory)
              .map((block) => (
                <BlockView
                  key={block.id}
                  block={block}
                  isNew={parentBlocks !== null && !parentBlocks.has(block.id)}
                  belief={block.kind === "intervention" ? beliefOf(block.intervention.targets) : ""}
                  preview={viewingHistory}
                />
              ))}
          </section>
        ))}

      {!viewingHistory && (
        <section className="quiz" aria-label="Quiz">
          <div className="quiz-top">
            <h2>Check your understanding</h2>
            <span className="small muted">Pass at 75%</span>
          </div>
          {error && <div className="notice">{error}</div>}
          {result ? (
            <Result
              result={result}
              snapshot={snapshot}
              beliefOf={beliefOf}
              nextLesson={next ? { id: next.id, title: next.title } : null}
              onOpenLesson={props.onOpenLesson}
              onRetake={() => {
                setResult(null);
                setAttempt((a) => a + 1);
              }}
            />
          ) : (
            // A new attempt, or a release that changes the questions, starts the quiz fresh.
            <QuizFlow key={`${attempt}:${lesson.quiz.map((q) => q.id).join()}`} quiz={lesson.quiz} busy={busy} onSubmit={submit} />
          )}
        </section>
      )}
    </article>
  );
}
