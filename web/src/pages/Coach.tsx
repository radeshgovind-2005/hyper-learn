import { marked } from "marked";
import { useCallback, useEffect, useState } from "react";
import { InterventionView } from "../components/Interventions.js";
import type { Citations } from "../components/LessonView.js";
import { QuizFlow } from "../components/Quiz.js";
import { shortName } from "../passage.js";
import type { Call, Certainty, CourseSnapshot, Response } from "../types.js";

// The study coach: "I'm stuck" → a short diagnostic across the lesson and what it builds on → the one
// thing to fix now, and why → a lesson written for you from the course's own pages → new questions to
// check it worked → the next thing, or the exam. The server decides what to fix and whether it's fixed;
// this page walks the learner through it. Personal state is fetched (and polled while a lesson is
// written), never broadcast.

const html = (markdown: string) => ({ __html: marked.parse(markdown, { async: false }) as string });
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Target {
  kind: "gap" | "misconception" | "objective" | "ready";
  lesson: string;
  id?: string;
  objective?: string;
  why: string;
}
interface Question {
  lesson: string;
  item: Parameters<typeof QuizFlow>[0]["quiz"][number];
}
interface CoachView {
  diagnosis?: {
    id: string;
    lesson: string;
    note?: string;
    status: "open" | "done";
    questions: Question[];
    result?: {
      map: { id: string; lesson: string; statement: string; state: "strong" | "shaky" | "missing" }[];
      priority: Target;
      next: Target[];
      score: number;
    };
  };
  repair?: {
    id: string;
    target: Target;
    approach: "refute" | "worked_example" | "smaller_steps";
    attempt: number;
    status: "running" | "ready" | "failed" | "fixed" | "not_yet";
    lesson?: { title: string; section: { blocks: { markdown: string; cites: { source: string; page: number }[] }[]; check: { prompt: string; options: { text: string; correct: boolean; feedback: string }[] } }; doubts: string[] };
    fallback?: { kind: "intervention"; block_id: string } | { kind: "review"; lesson: string; section_id: string };
    problems?: string[];
    recheck?: Question[];
  };
  fixed: string[];
  repairs_left: number;
  writes: boolean;
}

const keyOf = (t: Target) => (t.kind === "misconception" || t.kind === "objective" ? `${t.kind}:${t.id}` : `${t.kind}:${t.lesson}${t.kind === "gap" && t.objective ? `:${t.objective}` : ""}`);
const APPROACH: Record<NonNullable<CoachView["repair"]>["approach"], string> = {
  refute: "Untangling the mix-up",
  worked_example: "A worked example",
  smaller_steps: "Step by step",
};
const STATE_LABEL = { strong: "Got it", shaky: "Partly", missing: "Not yet" } as const;

/** What the coach works on: the repair in hand (unless fixed), else the first target not fixed yet. */
function focusOf(result: { priority: Target; next: Target[] }, repair: CoachView["repair"], fixed: readonly string[]): Target {
  if (repair && repair.status !== "fixed") return repair.target;
  const open = [result.priority, ...result.next].find((t) => t.kind !== "ready" && !fixed.includes(keyOf(t)));
  if (repair?.status === "fixed" && !open) return { kind: "ready", lesson: result.priority.lesson, why: "Everything this diagnosis found is fixed." };
  return open ?? result.priority;
}

function targetTitle(snapshot: CourseSnapshot, t: Target): string {
  const lesson = snapshot.lessons.find((l) => l.id === t.lesson)?.title ?? t.lesson;
  const objective = (id?: string) => snapshot.objectives?.find((o) => o.id === id)?.statement;
  if (t.kind === "misconception") return `The mix-up: “${snapshot.misconceptions.find((m) => m.id === t.id)?.belief ?? t.id}”`;
  if (t.kind === "objective") return objective(t.id) ?? lesson;
  if (t.kind === "gap") return `From an earlier lesson, “${lesson}”${t.objective ? `: ${objective(t.objective)}` : ""}`;
  return lesson;
}

/** The personal lesson: its text with the pages it cites, and a practice question with feedback. */
function PersonalLesson({ lesson, citations }: { lesson: NonNullable<NonNullable<CoachView["repair"]>["lesson"]>; citations?: Citations | undefined }) {
  const [picked, setPicked] = useState<number | null>(null);
  const check = lesson.section.check;
  return (
    <div className="personal stack">
      {lesson.section.blocks.map((b, i) => (
        <div key={i}>
          <div className="prose" dangerouslySetInnerHTML={html(b.markdown)} />
          {citations && b.cites.length > 0 && (
            <div className="cites">
              {b.cites.map((c) => {
                const source = citations.sources.get(c.source);
                return source ? (
                  <button key={`${c.source}-${c.page}`} className="chip cite" onClick={() => citations.open(source, c.page, b.markdown)}>
                    {shortName(source.name)} · p.{c.page}
                  </button>
                ) : null;
              })}
            </div>
          )}
        </div>
      ))}
      <div className="block check">
        <div className="check-label small">Practice</div>
        <div className="prompt">{check.prompt}</div>
        <div className="options" role="radiogroup">
          {check.options.map((o, i) => (
            <button key={i} className={`option ${picked === i ? "picked" : ""}`} role="radio" aria-checked={picked === i} onClick={() => setPicked(i)}>
              <span className="mark" aria-hidden />
              <span>{o.text}</span>
            </button>
          ))}
        </div>
        {picked !== null && (
          <div className={`check-feedback ${check.options[picked]!.correct ? "right" : "wrong"}`} role="status">
            <strong>{check.options[picked]!.correct ? "Right." : "Not quite."}</strong> {check.options[picked]!.feedback}
          </div>
        )}
      </div>
      {lesson.doubts.length > 0 && <p className="small muted">The fact check wasn't fully sure about: {lesson.doubts.slice(0, 2).join("; ")}. The cited pages have the original.</p>}
    </div>
  );
}

export function Coach({
  call,
  snapshot,
  lessonId,
  citations,
  onOpenLesson,
  onOpenSection,
}: {
  call: Call;
  snapshot: CourseSnapshot;
  lessonId: string;
  citations?: Citations;
  onOpenLesson: (id: string) => void;
  onOpenSection: (lesson: string, section: string) => void;
}) {
  const [view, setView] = useState<CoachView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restart, setRestart] = useState(false);
  const [lesson, setLesson] = useState(lessonId);
  const [note, setNote] = useState("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ fixed: boolean; next: Target | null } | null>(null);

  const load = useCallback(() => {
    void call<CoachView>("coachState")
      .then(setView)
      .catch((e: unknown) => setError(message(e)));
  }, [call]);
  useEffect(load, [load]);
  // While a lesson is being written, ask again every few seconds.
  const running = view?.repair?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [running, load]);

  const act = async (fn: () => Promise<CoachView | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) setView(next);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const repairTarget = (key?: string, again = false) =>
    act(async () => {
      setChecking(false);
      setChecked(null);
      return call<CoachView>("startRepair", [key, again]);
    });

  if (!view) return <div className="empty">{error ?? "Loading your coach…"}</div>;
  const lessons = snapshot.lessons.filter((l) => !l.archived);
  const d = view.diagnosis;
  const repair = view.repair;
  const starting = restart || !d;

  return (
    <article className="page coach">
      <div className="eyebrow">Study coach</div>
      <h1>Let's find what's in the way</h1>
      <p className="lede">A few questions show where you are. Then the coach fixes the one thing that matters most right now, writing a lesson just for you, and checks it worked.</p>
      {error && <div className="notice">{error}</div>}

      {starting ? (
        <section className="card studio-card">
          <h2>Where are you stuck?</h2>
          <label className="field">
            <span>Lesson</span>
            <select className="input" value={lesson} onChange={(e) => setLesson(e.target.value)}>
              {lessons.map((l, i) => (
                <option key={l.id} value={l.id}>
                  {i + 1}. {l.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>In your words, what's confusing? (optional)</span>
            <textarea className="input text" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. I don't see why more cores don't make my program faster" />
          </label>
          <div className="row">
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setRestart(false);
                  setChecked(null);
                  return call<CoachView>("startDiagnosis", [lesson, note.trim() || undefined]);
                })
              }
            >
              Diagnose me
            </button>
            <span className="small muted">About 5 questions, from this lesson and the ones it builds on. Not graded.</span>
          </div>
        </section>
      ) : d.status === "open" ? (
        <section className="quiz coach-quiz" aria-label="Diagnostic">
          <div className="quiz-top">
            <h2>Where are you?</h2>
            <span className="small muted">Not graded: answer as you would</span>
          </div>
          <QuizFlow
            key={d.id}
            quiz={d.questions.map((q) => q.item)}
            busy={busy}
            onSubmit={(answers: Response[], _c: Certainty[]) => void act(() => call<CoachView>("submitDiagnosis", [d.id, answers]))}
          />
        </section>
      ) : (
        d.result && (
          <>
            <section className="card studio-card">
              <div className="row between">
                <h2>Your map</h2>
                <button className="btn quiet sm" onClick={() => setRestart(true)}>
                  New diagnosis
                </button>
              </div>
              <ul className="coach-map">
                {d.result.map.map((m) => (
                  <li key={m.id} className={m.state}>
                    <span className={`chip ${m.state === "strong" ? "green" : m.state === "shaky" ? "amber" : "red"}`}>{STATE_LABEL[m.state]}</span>
                    <span className="grow">{m.statement}</span>
                    <span className="small muted">{snapshot.lessons.find((l) => l.id === m.lesson)?.title}</span>
                  </li>
                ))}
              </ul>
            </section>

            {focusOf(d.result, repair, view.fixed).kind === "ready" ? (
              <section className="card studio-card coach-focus">
                <h2>You're ready</h2>
                <p>{d.result.priority.kind === "ready" ? d.result.priority.why : "Everything this diagnosis found is fixed."}</p>
                <div className="row">
                  <button className="btn primary" onClick={() => onOpenLesson(d.lesson)}>
                    Take the exam →
                  </button>
                </div>
              </section>
            ) : (
              <section className="card studio-card coach-focus">
                <div className="eyebrow">The one thing to fix now</div>
                <h2>{targetTitle(snapshot, checked && repair ? repair.target : focusOf(d.result, repair, view.fixed))}</h2>
                <p className="small">{(checked && repair ? repair.target : focusOf(d.result, repair, view.fixed)).why}</p>

                {!repair || (repair.status === "fixed" && !checked) || (!checked && repair.status !== "running" && keyOf(repair.target) !== keyOf(focusOf(d.result, repair, view.fixed))) ? (
                  <div className="row">
                    <button className="btn primary" disabled={busy} onClick={() => void repairTarget(keyOf(focusOf(d.result!, repair, view.fixed)))}>
                      Fix this for me
                    </button>
                    {view.writes && <span className="small muted">{view.repairs_left} personal lessons left today</span>}
                  </div>
                ) : repair.status === "running" ? (
                  <div className="row small">
                    <span className="spinner" />
                    <span>Writing a lesson just for you from the course's pages ({APPROACH[repair.approach].toLowerCase()}), and fact-checking it… about half a minute.</span>
                  </div>
                ) : repair.status === "failed" ? (
                  <div className="notice stack">
                    <span>{repair.problems?.join(" · ") ?? "That didn't work."}</span>
                    <div className="row">
                      <button className="btn secondary sm" disabled={busy} onClick={() => void repairTarget(keyOf(repair.target), true)}>
                        Try another way
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="stack">
                    <div className="row small">
                      <span className="chip violet">For you</span>
                      <span className="muted">
                        {repair.lesson ? APPROACH[repair.approach] : "From the course"}
                        {repair.attempt > 0 ? ` · try ${repair.attempt + 1}` : ""}
                      </span>
                    </div>
                    {repair.lesson && <PersonalLesson lesson={repair.lesson} citations={citations} />}
                    {repair.fallback?.kind === "intervention" &&
                      (() => {
                        const block = snapshot.lessons.flatMap((l) => l.sections.flatMap((s) => s.blocks)).find((b) => b.id === (repair.fallback as { block_id: string }).block_id);
                        return block?.kind === "intervention" ? <InterventionView intervention={block.intervention} /> : null;
                      })()}
                    {repair.fallback?.kind === "review" && (
                      <div className="row">
                        <button className="btn secondary" onClick={() => onOpenSection((repair.fallback as { lesson: string }).lesson, (repair.fallback as { section_id: string }).section_id)}>
                          Read the section that teaches it
                        </button>
                      </div>
                    )}

                    {checked ? (
                      <div className={`result ${checked.fixed ? "pass" : "fail"}`}>
                        <h3>{checked.fixed ? "Fixed ✓" : "Not quite yet"}</h3>
                        {checked.fixed ? (
                          checked.next ? (
                            <div className="stack">
                              <span className="small">Next: {targetTitle(snapshot, checked.next)}</span>
                              <div className="row">
                                <button className="btn primary" disabled={busy} onClick={() => void repairTarget(keyOf(checked.next!))}>
                                  Fix the next thing
                                </button>
                                <button className="btn quiet" onClick={() => onOpenLesson(d.lesson)}>
                                  Back to the lesson
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="row">
                              <button className="btn primary" onClick={() => onOpenLesson(d.lesson)}>
                                Take the exam →
                              </button>
                            </div>
                          )
                        ) : (
                          <div className="row">
                            <button className="btn primary" disabled={busy} onClick={() => void repairTarget(keyOf(repair.target), true)}>
                              Try another way
                            </button>
                            <span className="small">A different explanation, not the same one again.</span>
                          </div>
                        )}
                      </div>
                    ) : checking && repair.recheck && repair.recheck.length > 0 ? (
                      <section className="quiz coach-quiz" aria-label="Check">
                        <div className="quiz-top">
                          <h2>Check you've got it</h2>
                          <span className="small muted">New questions</span>
                        </div>
                        <QuizFlow
                          key={repair.id}
                          quiz={repair.recheck.map((q) => q.item)}
                          busy={busy}
                          onSubmit={(answers: Response[]) =>
                            void act(async () => {
                              const r = await call<{ fixed: boolean; next: Target | null; state: CoachView }>("submitRecheck", [repair.id, answers]);
                              setChecked({ fixed: r.fixed, next: r.next });
                              return r.state;
                            })
                          }
                        />
                      </section>
                    ) : repair.recheck && repair.recheck.length > 0 ? (
                      <div className="row">
                        <button className="btn primary" onClick={() => setChecking(true)}>
                          Check I've got it
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            )}

            {d.result.next.length > 0 && (
              <section className="card studio-card">
                <h2>After that</h2>
                <ul className="coach-next">
                  {d.result.next.map((t) => (
                    <li key={keyOf(t)}>
                      <span className="grow">
                        {view.fixed.includes(keyOf(t)) && <span className="chip green">Fixed</span>} {targetTitle(snapshot, t)}
                      </span>
                      {!view.fixed.includes(keyOf(t)) && (
                        <button className="btn quiet sm" disabled={busy || running} onClick={() => void repairTarget(keyOf(t))}>
                          Fix this instead
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      )}
    </article>
  );
}
