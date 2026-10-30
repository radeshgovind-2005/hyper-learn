import { useCallback, useEffect, useState } from "react";
import type { Call } from "../types.js";
import { minutes, pct, type Progress, ProgressSections, when } from "./MyProgress.js";

interface LearnerRow {
  user_id: string;
  name: string | null;
  email: string | null;
  role: string;
  last_active: string | null;
  sessions: number;
  active_ms: number;
  quizzes: number;
  mastered: number;
  lessons: number;
  open_beliefs: { id: string; belief: string; lesson: string }[];
  needs_help: boolean;
}
interface LearnersData {
  summary: { learners: number; active_this_week: number; needs_help: number; common_beliefs: { id: string; belief: string; learners: number }[] };
  learners: LearnerRow[];
  /** Pass back for the next page; null on the last one. */
  next_cursor: string | null;
}
interface Detail {
  profile: { user_id: string; name: string | null; email: string | null; role: string };
  progress: Progress;
  timeline: { at: string; kind: string; lesson: string | null; text: string; outcome?: "pass" | "fail" }[];
}

const display = (p: { name: string | null; email: string | null; user_id: string }) => p.name ?? p.email ?? p.user_id;
const initials = (text: string) => text.replace(/^user_/, "").slice(0, 2).toUpperCase();

function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** Instructors: every learner at a glance, who needs help, and which beliefs are most widespread. */
export function Learners({ call, onOpen }: { call: Call; onOpen: (userId: string) => void }) {
  const [data, setData] = useState<LearnersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyHelp, setOnlyHelp] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);
  // The server pages and filters: a course can have thousands of learners.
  useEffect(() => {
    setData(null);
    void call<LearnersData>("learners", [{ needs_help: onlyHelp }]).then(setData, fail);
  }, [call, onlyHelp, fail]);
  const loadMore = () => {
    if (!data?.next_cursor) return;
    setLoadingMore(true);
    void call<LearnersData>("learners", [{ needs_help: onlyHelp, cursor: data.next_cursor }])
      .then((next) => setData((d) => (d ? { ...next, learners: [...d.learners, ...next.learners] } : next)), fail)
      .finally(() => setLoadingMore(false));
  };
  const rows = data?.learners ?? [];

  if (error) return <div className="lesson"><div className="notice">{error}</div></div>;
  if (!data) return <div className="empty">Loading learners…</div>;
  return (
    <article className="lesson wide">
      <div className="crumbs">Instructors</div>
      <h1>Learners</h1>
      <p className="lede">Who's learning, who's stuck, and on what.</p>

      <div className="tiles">
        <div className="tile"><span className="value">{data.summary.learners}</span><span className="label">learners</span></div>
        <div className="tile"><span className="value">{data.summary.active_this_week}</span><span className="label">active this week</span></div>
        <div className="tile"><span className="value">{data.summary.needs_help}</span><span className="label">need help</span></div>
      </div>

      {data.summary.common_beliefs.length > 0 && (
        <section className="section">
          <h2>Most widespread misconceptions</h2>
          <ul className="belief-list">
            {data.summary.common_beliefs.map((b) => (
              <li key={b.id} className="belief open">
                <span className="chip amber">{b.learners} learner{b.learners === 1 ? "" : "s"}</span>
                <span className="grow">“{b.belief}”</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Everyone</h2>
          <div className="segmented" role="group" aria-label="Filter learners">
            <button className={!onlyHelp ? "on" : ""} onClick={() => setOnlyHelp(false)}>All</button>
            <button className={onlyHelp ? "on" : ""} onClick={() => setOnlyHelp(true)}>Needs help</button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p className="muted">{onlyHelp ? "Nobody needs help right now." : "No learners yet."}</p>
        ) : (
          <ul className="learner-rows">
            {rows.map((l) => (
              <li key={l.user_id}>
                <button className="learner-row" onClick={() => onOpen(l.user_id)}>
                  <span className="avatar">{initials(display(l))}</span>
                  <span className="who">
                    <span className="name">{display(l)}</span>
                    <span className="small muted">
                      {l.role !== "learner" ? `${l.role} · ` : ""}active {ago(l.last_active)} · {l.sessions} session{l.sessions === 1 ? "" : "s"} · {minutes(l.active_ms)}
                    </span>
                  </span>
                  <span className="beliefs">
                    {l.open_beliefs.slice(0, 2).map((b) => (
                      <span key={b.id} className="chip amber" title={b.belief}>{b.id}</span>
                    ))}
                    {l.open_beliefs.length > 2 && <span className="chip">+{l.open_beliefs.length - 2}</span>}
                  </span>
                  <span className="mastery" aria-label={`${l.mastered} of ${l.lessons} lessons mastered`}>
                    <span className="meter"><span style={{ width: pct(l.mastered / Math.max(1, l.lessons)), background: "var(--green)" }} /></span>
                    <span className="small">{l.mastered}/{l.lessons}</span>
                  </span>
                  {l.needs_help ? <span className="chip red">needs help</span> : <span className="chip green">on track</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {data.next_cursor && (
          <div className="row" style={{ marginTop: "var(--s4)" }}>
            <button className="btn secondary sm" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
            <span className="small muted">
              Showing {rows.length} of {onlyHelp ? data.summary.needs_help : data.summary.learners}
            </span>
          </div>
        )}
      </section>
    </article>
  );
}

const ROLE_HELP: Record<string, string> = {
  learner: "Lessons, quizzes and their own progress.",
  instructor: "Also sees every learner and runs course repair.",
  admin: "Also resets the course and changes roles.",
};

/** Admins: changes someone's role in Clerk. It applies when their browser next connects. */
function RoleControl({ call, userId, role, self, configured, onChanged }: { call: Call; userId: string; role: string; self: string; configured: boolean; onChanged: (role: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const disabled = busy || !configured || userId === self;
  const change = (next: string) => {
    if (next === role) return;
    setBusy(true);
    setMessage(null);
    call<{ role: string }>("setRole", [userId, next])
      .then((r) => {
        onChanged(r.role);
        setMessage("Saved. It applies the next time they open or reload HyperLearn.");
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="card soft stack" aria-label="Role">
      <div className="field">
        <span>Role</span>
        <div className="segmented" role="group" aria-label="Role">
          {["learner", "instructor", "admin"].map((r) => (
            <button key={r} className={role === r ? "on" : ""} disabled={disabled} aria-pressed={role === r} onClick={() => change(r)}>
              {r[0]!.toUpperCase() + r.slice(1)}
            </button>
          ))}
        </div>
        <span className="footnote">
          {userId === self
            ? "This is you. Another admin can change your role."
            : !configured
              ? "Changing roles here needs CLERK_SECRET_KEY on the Worker. Until then, set it in the Clerk dashboard."
              : ROLE_HELP[role]}
        </span>
      </div>
      {message && <div className="small" role="status">{message}</div>}
    </section>
  );
}

/** Instructors: one learner's progress, and everything they did, newest first. Admins can change their role. */
export function LearnerDetail({
  call,
  userId,
  onBack,
  roles,
}: {
  call: Call;
  userId: string;
  onBack: () => void;
  /** Set for admins: who they are (they can't change their own role) and whether the Worker can change roles. */
  roles: { self: string; configured: boolean } | null;
}) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void call<Detail>("learnerDetail", [userId]).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : String(e))), [call, userId]);

  if (error) return <div className="lesson"><div className="notice">{error}</div></div>;
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <article className="lesson">
      <button className="btn quiet sm" onClick={onBack} style={{ marginLeft: "calc(-1 * var(--s3))" }}>← All learners</button>
      <h1 style={{ marginTop: "var(--s3)" }}>{display(data.profile)}</h1>
      <p className="lede">
        {data.profile.email && data.profile.name ? `${data.profile.email} · ` : ""}
        {data.profile.role}
      </p>
      {roles && (
        <RoleControl
          call={call}
          userId={userId}
          role={data.profile.role}
          self={roles.self}
          configured={roles.configured}
          onChanged={(role) => setData({ ...data, profile: { ...data.profile, role } })}
        />
      )}
      <ProgressSections data={data.progress} />
      <section className="section">
        <h2>Timeline</h2>
        {data.timeline.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <ol className="timeline-list">
            {data.timeline.map((t, i) => (
              <li key={i} className={t.outcome ?? t.kind}>
                <span className="dot" aria-hidden />
                <span className="grow">{t.text}</span>
                <time className="small muted" dateTime={t.at}>{when(t.at)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
