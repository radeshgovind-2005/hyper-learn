import { useEffect, useState } from "react";
import type { Call } from "../types.js";

export interface Progress {
  totals: { active_ms: number; sessions: number; quizzes: number; mastered: number; lessons: number };
  lessons: { lesson: string; title: string; active_ms: number; attempts: number; passed: boolean; mastery: number; mastered: boolean }[];
  sessions: { start: string; end: string; duration_ms: number; lessons: string[]; quizzes: number }[];
  quizzes: { lesson: string; at: string; score: number; passed: boolean; release: string }[];
  beliefs: { id: string; belief: string; lesson: string; first_seen: string; last_seen: string; times: number; cleared: boolean }[];
  interventions: { block_id: string; first_shown: string; completed: boolean; context: "path" | "preview" }[];
}

export const minutes = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Tiles, lessons, beliefs, sessions and quizzes: the same view for a learner's own page and an instructor's. */
export function ProgressSections({ data, onOpenLesson }: { data: Progress; onOpenLesson?: (id: string) => void }) {
  const title = (id: string) => data.lessons.find((l) => l.lesson === id)?.title ?? id;
  const open = data.beliefs.filter((b) => !b.cleared);
  const cleared = data.beliefs.filter((b) => b.cleared);
  return (
    <>
      <div className="tiles">
        <div className="tile"><span className="value">{data.totals.mastered}<span className="of">/{data.totals.lessons}</span></span><span className="label">lessons mastered</span></div>
        <div className="tile"><span className="value">{minutes(data.totals.active_ms)}</span><span className="label">time learning</span></div>
        <div className="tile"><span className="value">{data.totals.sessions}</span><span className="label">sessions</span></div>
        <div className="tile"><span className="value">{data.totals.quizzes}</span><span className="label">quizzes taken</span></div>
      </div>

      <section className="section">
        <h2>Lessons</h2>
        <ul className="lesson-rows">
          {data.lessons.map((l) => (
            <li key={l.lesson}>
              <button className="lesson-row" onClick={() => onOpenLesson?.(l.lesson)} disabled={!onOpenLesson}>
                <span className="grow">
                  <span className="name">{l.title}</span>
                  <span className="small muted">
                    {l.attempts === 0 ? "Not started" : `${l.attempts} attempt${l.attempts === 1 ? "" : "s"} · ${l.passed ? "passed" : "not passed yet"}`} · {minutes(l.active_ms)}
                  </span>
                </span>
                <span className="mastery" aria-label={`Mastery ${pct(l.mastery)}`}>
                  <span className="meter"><span style={{ width: pct(l.mastery), background: l.mastered ? "var(--green)" : "var(--blue)" }} /></span>
                  <span className="small">{l.mastered ? "Mastered" : pct(l.mastery)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="section">
        <h2>Ideas to revisit</h2>
        {data.beliefs.length === 0 ? (
          <p className="muted">Nothing yet. When an answer suggests a common misunderstanding, it shows up here until it's cleared.</p>
        ) : (
          <ul className="belief-list">
            {open.map((b) => (
              <li key={b.id} className="belief open">
                <span className="chip amber">Still showing</span>
                <span className="grow">“{b.belief}”<span className="small muted"> · {title(b.lesson)} · seen {b.times}×</span></span>
                {onOpenLesson && <button className="btn secondary sm" onClick={() => onOpenLesson(b.lesson)}>Review</button>}
              </li>
            ))}
            {cleared.map((b) => (
              <li key={b.id} className="belief">
                <span className="chip green">Cleared</span>
                <span className="grow">“{b.belief}”<span className="small muted"> · {title(b.lesson)}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section two-col">
        <div>
          <h2>Recent sessions</h2>
          {data.sessions.length === 0 ? <p className="muted">No sessions yet.</p> : (
            <ul className="plain-list">
              {data.sessions.slice(0, 8).map((s) => (
                <li key={s.start}>
                  <strong>{when(s.start)}</strong>
                  <span className="small muted"> · {minutes(s.duration_ms)} · {s.lessons.length} lesson{s.lessons.length === 1 ? "" : "s"} · {s.quizzes} quiz{s.quizzes === 1 ? "" : "zes"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2>Recent quizzes</h2>
          {data.quizzes.length === 0 ? <p className="muted">No quizzes yet.</p> : (
            <ul className="plain-list">
              {data.quizzes.slice(0, 8).map((q) => (
                <li key={q.at}>
                  <span className={`chip ${q.passed ? "green" : "amber"}`}>{pct(q.score)}</span> <strong>{title(q.lesson)}</strong>
                  <span className="small muted"> · {when(q.at)} · v{q.release}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

/** The signed-in learner's own record: mastery, time, sessions, quizzes and beliefs, and a way to delete it. */
export function MyProgress({ call, onOpenLesson }: { call: Call; onOpenLesson: (id: string) => void }) {
  const [data, setData] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);

  const load = () => void call<Progress>("myProgress").then(setData, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(load, [call]);

  if (error) return <div className="lesson"><div className="notice">{error}</div></div>;
  if (!data) return <div className="empty">Loading your progress…</div>;

  return (
    <article className="lesson progress-page">
      <div className="crumbs">Your account</div>
      <h1>My progress</h1>
      <p className="lede">Everything here is recorded under your account and follows you across devices.</p>

      <ProgressSections data={data} onOpenLesson={onOpenLesson} />

      <section className="section danger-zone">
        <h2>Your data</h2>
        <p className="small muted">
          Deleting removes your quiz answers, sessions and activity from HyperLearn. Your sign-in account itself is managed from the account menu.
        </p>
        {deleted !== null ? (
          <div className="notice">Deleted {deleted} records.</div>
        ) : confirming ? (
          <div className="row">
            <span className="small">This can't be undone.</span>
            <button
              className="btn danger sm"
              onClick={() =>
                void call<{ deleted: number }>("deleteMyData").then((r) => {
                  setDeleted(r.deleted);
                  setConfirming(false);
                  load();
                })
              }
            >
              Delete everything
            </button>
            <button className="btn quiet sm" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        ) : (
          <button className="btn danger sm" onClick={() => setConfirming(true)}>Delete my data</button>
        )}
      </section>
    </article>
  );
}
