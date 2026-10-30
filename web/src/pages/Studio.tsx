import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Citations, LessonView } from "../components/LessonView.js";
import type { SourceTarget } from "../components/SourceViewer.js";
import { ACCEPTED, chunkPages, readFile } from "../files.js";
import { AudienceField } from "./CreateCourse.js";
import type { BuildState, BuildStep, Call, CourseDetails, CourseSnapshot, Member, ModelSettings, Overview, OwnerSourceSummary, SourceRole, SourceSummary } from "../types.js";

// The owner's page for one course: what it is, the files it is built from, the model key, the build, a
// preview, publishing and sharing. Every call is checked on the server (manage_course); this page only
// lays them out in the order an owner needs them.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs an action, keeping its error for the card it belongs to. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

function Card({
  step,
  title,
  done,
  danger,
  children,
  aside,
}: {
  /** Absent: a card that isn't a step (deleting). */
  step?: number;
  title: string;
  done?: boolean;
  danger?: boolean;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className={`card studio-card ${danger ? "danger" : ""}`}>
      <div className="studio-card-head">
        {step !== undefined && <span className={`num ${done ? "mastered" : ""}`}>{done ? "✓" : step}</span>}
        <h2 className="grow">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Details({ call, details, onSaved }: { call: Call; details: CourseDetails; onSaved: (d: CourseDetails) => void }) {
  const [form, setForm] = useState(details);
  const { busy, error, run } = useAction();
  const changed = (["title", "description", "goal", "language", "audience"] as const).some((k) => form[k] !== details[k]);
  const set = (key: "title" | "description" | "goal" | "language") => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const { title, description, goal, language, audience } = form;
          await call("updateDetails", [{ title, description, goal, language, audience }]);
          onSaved(form);
        });
      }}
    >
      <label className="field">
        <span>Title</span>
        <input className="input" value={form.title} onChange={set("title")} maxLength={120} required />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea className="input text" rows={2} value={form.description} onChange={set("description")} maxLength={2000} />
      </label>
      <label className="field">
        <span>Goal: what should learners be able to do at the end?</span>
        <textarea className="input text" rows={2} value={form.goal} onChange={set("goal")} maxLength={2000} placeholder="e.g. Choose a parallel architecture for a problem and explain the trade-offs" />
      </label>
      <label className="field">
        <span>Language (optional)</span>
        <input className="input" value={form.language} onChange={set("language")} maxLength={40} placeholder="The material's language" />
      </label>
      <AudienceField value={form.audience} onChange={(audience) => setForm((f) => ({ ...f, audience }))} />
      {error && <div className="notice">{error}</div>}
      <div className="row">
        <button className="btn secondary sm" type="submit" disabled={busy || !changed || !form.title.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

const ROLE_LABEL: Record<SourceRole, string> = {
  material: "Teaching material",
  assessment: "Past exam or test",
  brief: "Project brief",
};

interface Upload {
  name: string;
  status: string;
  error?: string;
}

/** Roles learners never see, whatever the owner's switch says (the server enforces it). */
const NEVER_SHOWN: ReadonlySet<SourceRole> = new Set(["assessment", "brief"]);

function Sources({
  call,
  sources,
  locked,
  onChange,
  onView,
}: {
  call: Call;
  sources: OwnerSourceSummary[];
  locked: string | null;
  onChange: () => void;
  onView: (source: OwnerSourceSummary) => void;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const { error, run } = useAction();
  const input = useRef<HTMLInputElement>(null);

  const update = (name: string, patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.name === name ? { ...u, ...patch } : u)));

  async function add(files: File[]) {
    setUploads((list) => [...list.filter((u) => !files.some((f) => f.name === u.name)), ...files.map((f) => ({ name: f.name, status: "Waiting…" }))]);
    // One at a time: each file's pages are read here, then sent in messages the server accepts.
    for (const file of files) {
      try {
        update(file.name, { status: "Reading…" });
        const read = await readFile(file, (page, of) => update(file.name, { status: `Reading page ${page} of ${of}…` }));
        const chunks = chunkPages(read.pages);
        update(file.name, { status: "Uploading…" });
        let summary = await call<SourceSummary>("addSource", [{ name: read.name, pages: chunks[0] }]);
        for (const chunk of chunks.slice(1)) summary = await call<SourceSummary>("appendPages", [summary.id, chunk]);
        setUploads((list) => list.filter((u) => u.name !== file.name));
        onChange();
      } catch (e) {
        update(file.name, { status: "Not added", error: message(e) });
      }
    }
  }

  const pick = (list: FileList | null) => list && list.length > 0 && void add([...list]);

  return (
    <div className="stack">
      <p className="small muted">
        Lectures, notes and book chapters teach. Past exams and tests show what is assessed: the build writes its own questions in their style, never copies them. PDF,
        Markdown or text. PDFs are read in your browser.
      </p>
      {locked ? (
        <div className="notice">{locked}</div>
      ) : (
        <div
          className={`dropzone ${dragging ? "over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files);
          }}
        >
          <span>Drop files here, or</span>
          <button className="btn secondary sm" type="button" onClick={() => input.current?.click()}>
            Choose files
          </button>
          <input
            ref={input}
            type="file"
            accept={ACCEPTED}
            multiple
            hidden
            onChange={(e) => {
              pick(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      )}

      {(sources.length > 0 || uploads.length > 0) && (
        <ul className="file-list">
          {sources.map((s) => (
            <li key={s.id} className="file-row">
              <span className="grow">
                <span className="file-name">{s.name}</span>
                <span className="small muted">
                  {" "}
                  · {s.pages} {s.pages === 1 ? "page" : "pages"}
                </span>
              </span>
              {s.role && NEVER_SHOWN.has(s.role) ? null : (
                <label className="share-toggle small" title="Learners can open this file's pages from the lessons that cite it">
                  <input
                    type="checkbox"
                    checked={s.shared}
                    onChange={(e) => void run(async () => {
                      await call("setSourceShared", [s.id, e.target.checked]);
                      onChange();
                    })}
                  />
                  Learners can open
                </label>
              )}
              <button className="btn quiet sm" type="button" onClick={() => onView(s)} aria-label={`View ${s.name}`}>
                View
              </button>
              <select
                className="input sm"
                value={s.role ?? ""}
                disabled={Boolean(locked)}
                aria-label={`What ${s.name} is`}
                onChange={(e) => void run(async () => {
                  await call("setSourceRole", [s.id, e.target.value || null]);
                  onChange();
                })}
              >
                <option value="">Let the build decide</option>
                {(Object.keys(ROLE_LABEL) as SourceRole[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
              {!locked && (
                <button
                  className="icon-btn"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => void run(async () => {
                    await call("removeSource", [s.id]);
                    onChange();
                  })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.name} className="file-row pending">
              <span className="grow">
                <span className="file-name">{u.name}</span>
                <span className={`small ${u.error ? "error-text" : "muted"}`}> · {u.error ?? u.status}</span>
              </span>
              {u.error && (
                <button className="icon-btn" aria-label={`Dismiss ${u.name}`} onClick={() => setUploads((list) => list.filter((x) => x.name !== u.name))}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {sources.length > 0 && (
        <p className="small muted">
          Learners see citation chips under the lessons and can open the pages they cite. Past exams and project briefs are never shown to learners, so they have no
          switch.
        </p>
      )}
      {error && <div className="notice">{error}</div>}
    </div>
  );
}

function ModelKey({ call, settings, onChange }: { call: Call; settings: ModelSettings; onChange: (s: ModelSettings) => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(settings.model ?? settings.choices[0] ?? "");
  const [editing, setEditing] = useState(!settings.hasKey);
  const { busy, error, run } = useAction();

  if (!settings.keysAvailable) {
    return <div className="notice">This server can't store model keys yet: its KEY_ENCRYPTION_SECRET isn't set.</div>;
  }
  if (!editing && settings.hasKey) {
    return (
      <div className="stack">
        <div className="row small">
          <span className="chip green">Key saved</span>
          <span className="muted">
            {settings.model} · set {settings.set_at ? new Date(settings.set_at).toLocaleDateString() : ""}
          </span>
        </div>
        <div className="row">
          <button className="btn secondary sm" onClick={() => setEditing(true)}>
            Replace key
          </button>
          <button className="btn quiet sm" disabled={busy} onClick={() => void run(async () => onChange(await call<ModelSettings>("clearModelKey")))}>
            Remove key
          </button>
        </div>
        {error && <div className="notice">{error}</div>}
      </div>
    );
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          onChange(await call<ModelSettings>("setModelKey", [key, model]));
          setKey("");
          setEditing(false);
        });
      }}
    >
      <p className="small muted">
        The build runs on your own Meta Model API key (from dev.meta.ai). It is stored encrypted, used only for this course, and never shown again.
      </p>
      <label className="field">
        <span>API key</span>
        <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} required />
      </label>
      {settings.choices.length > 1 && (
        <label className="field">
          <span>Model</span>
          <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
            {settings.choices.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="notice">{error}</div>}
      <div className="row">
        <button className="btn secondary sm" type="submit" disabled={busy || !key.trim() || !model}>
          {busy ? "Saving…" : "Save key"}
        </button>
        {settings.hasKey && (
          <button className="btn quiet sm" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const STAGE_LABEL: Record<string, string> = {
  classify: "Sort files",
  digest: "Read",
  plan: "Plan",
  write: "Write",
  assess: "Questions",
  validate: "Check",
  review: "Fact check",
  stress: "Stress test",
  done: "Done",
};

/** ✓ done, ↻ sent back for a fix, ✗ the build stopped, … waiting. */
function stepMark(step: BuildStep): string {
  if (step.status === "ok") return "✓";
  if (step.status === "rejected") return step.stage === "done" ? "✗" : "↻";
  return step.status === "waiting" ? "…" : "·";
}

function elapsed(build: BuildState): string {
  const end = build.finished_at ? Date.parse(build.finished_at) : Date.now();
  const s = Math.max(0, Math.round((end - Date.parse(build.started_at)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function Build({ build, canBuild, blocker, onBuild, busy, error }: { build: BuildState | null; canBuild: boolean; blocker: string | null; onBuild: () => void; busy: boolean; error: string | null }) {
  const list = useRef<HTMLOListElement>(null);
  const running = build?.status === "running";
  // Keep the newest step in view while the build runs.
  useEffect(() => {
    if (running) list.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [running, build?.steps.length]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  return (
    <div className="stack">
      <p className="small muted">
        Agents read your files, plan lessons in prerequisite order, write each section from its pages, write exam questions per objective, and check every claim
        against the pages. A course from two lectures takes about 20 minutes.
      </p>
      <div className="row">
        <button className="btn primary" disabled={!canBuild || busy || running} onClick={onBuild} title={blocker ?? ""}>
          {running && <span className="spinner" />}
          {running ? "Building…" : build ? "Build again" : "Build course"}
        </button>
        {build && (
          <span className="small muted">
            {running ? "Running" : build.status === "done" ? "Built" : "Failed"} · {elapsed(build)}
            {build.model_calls ? ` · ${build.model_calls} model calls` : ""}
          </span>
        )}
      </div>
      {blocker && !running && <div className="small muted">{blocker}</div>}
      {error && <div className="notice">{error}</div>}
      {build && build.steps.length > 0 && (
        <ol className="build-steps" ref={list}>
          {build.steps.map((s, i) => (
            <li key={i} className={`build-step ${s.status}`}>
              <span className="chip">{STAGE_LABEL[s.stage] ?? s.stage}</span>
              <span className="grow">
                {s.title}
                {s.detail && s.status !== "ok" && <span className="build-detail">{s.detail}</span>}
              </span>
              <span aria-label={s.status}>{stepMark(s)}</span>
            </li>
          ))}
        </ol>
      )}
      {build?.status === "failed" && build.problems && (
        <div className="notice stack">
          <strong>The course wasn't built</strong>
          <ul className="small">
            {build.problems.slice(0, 8).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Preview({ call, draft, warnings, citations }: { call: Call; draft: CourseSnapshot; warnings: string[]; citations: Citations }) {
  const lessons = draft.lessons.filter((l) => !l.archived);
  const [lessonId, setLessonId] = useState<string | null>(null);
  const questions = lessons.reduce((n, l) => n + l.quiz.length, 0);
  const sections = lessons.reduce((n, l) => n + l.sections.length, 0);
  return (
    <div className="stack">
      <div className="row small">
        <span className="chip blue">{lessons.length} lessons</span>
        <span className="chip">{sections} sections</span>
        <span className="chip">{draft.objectives?.length ?? 0} objectives</span>
        <span className="chip">{questions} exam questions</span>
      </div>
      {warnings.length > 0 && (
        <div className="notice stack">
          <strong>Look at these before publishing</strong>
          <ul className="small">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="path">
        {lessons.map((l, i) => (
          <li key={l.id}>
            <button className={`path-item ${l.id === lessonId ? "on" : ""}`} onClick={() => setLessonId(l.id === lessonId ? null : l.id)} aria-expanded={l.id === lessonId}>
              <span className="num">{i + 1}</span>
              <span className="grow">{l.title}</span>
              <span className="small muted">{l.quiz.length} questions</span>
            </button>
          </li>
        ))}
      </ol>
      {lessonId && (
        <div className="preview-frame">
          <LessonView
            key={lessonId}
            snapshot={draft}
            parent={null}
            lessonId={lessonId}
            mode="preview"
            onBackToLive={() => {}}
            approvalWaiting={null}
            onReviewApproval={() => {}}
            call={call}
            onAnswered={() => {}}
            onOpenLesson={setLessonId}
            citations={citations}
          />
        </div>
      )}
    </div>
  );
}

function Share({ call, courseId }: { call: Call; courseId: string }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [members, setMembers] = useState<Member[]>([]);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(() => {
    void call<{ token: string | null }>("invite").then((i) => setToken(i.token));
    void call<Member[]>("members").then(setMembers);
  }, [call]);
  useEffect(load, [load]);
  const link = token ? `${location.origin}/join/${encodeURIComponent(courseId)}/${encodeURIComponent(token)}` : null;

  return (
    <div className="stack">
      <p className="small muted">Anyone with the link joins as a learner once the course is published. A new link turns the old one off.</p>
      {link ? (
        <div className="row">
          <input className="input grow" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
          <button
            className="btn secondary sm"
            onClick={() => void navigator.clipboard.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : null}
      <div className="row">
        <button className="btn secondary sm" disabled={busy || token === undefined} onClick={() => void run(async () => setToken((await call<{ token: string }>("rotateInvite")).token))}>
          {link ? "New link" : "Create invite link"}
        </button>
        {link && (
          <button
            className="btn quiet sm"
            disabled={busy}
            onClick={() => void run(async () => {
              await call("revokeInvite");
              setToken(null);
            })}
          >
            Turn link off
          </button>
        )}
      </div>
      {members.length > 0 && (
        <ul className="file-list">
          {members.map((m) => (
            <li key={m.user_id} className="file-row">
              <span className="grow">
                <span className="file-name">{m.name ?? m.email ?? m.user_id}</span>
                {m.name && m.email && <span className="small muted"> · {m.email}</span>}
              </span>
              {m.role === "owner" ? (
                <span className="chip">owner</span>
              ) : (
                <>
                  <select
                    className="input sm"
                    value={m.role}
                    aria-label={`Role of ${m.name ?? m.user_id}`}
                    onChange={(e) => void run(async () => {
                      await call("setMemberRole", [m.user_id, e.target.value]);
                      load();
                    })}
                  >
                    <option value="learner">Learner</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${m.name ?? m.user_id}`}
                    onClick={() => void run(async () => {
                      await call("removeMember", [m.user_id]);
                      load();
                    })}
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <div className="notice">{error}</div>}
    </div>
  );
}

/** The owner types the title to confirm, so a slip of the mouse can't delete a course. */
function DeleteCourse({ title, onDelete }: { title: string; onDelete: () => Promise<void> }) {
  const [typed, setTyped] = useState("");
  const { busy, error, run } = useAction();
  const confirmed = typed.trim() === title.trim();
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmed) void run(onDelete);
      }}
    >
      <p className="small muted">Deletes the course for everyone: its files, lessons, releases, members and every learner's progress. This can't be undone.</p>
      <label className="field">
        <span>Type the title to confirm: {title}</span>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      {error && <div className="notice">{error}</div>}
      <div className="row">
        <button className="btn danger sm" type="submit" disabled={!confirmed || busy}>
          {busy ? "Deleting…" : "Delete course"}
        </button>
      </div>
    </form>
  );
}

export function Studio({
  call,
  overview,
  courseId,
  onPublished,
  onOpenSource,
  onDelete,
}: {
  call: Call;
  overview: Overview | null;
  courseId: string;
  onPublished: () => void;
  /** Opens a file's page in the course's source drawer. */
  onOpenSource: (target: SourceTarget) => void;
  /** Deletes the course through the directory, then leaves its pages. */
  onDelete: () => Promise<void>;
}) {
  const [details, setDetails] = useState<CourseDetails | null>(null);
  const [sources, setSources] = useState<OwnerSourceSummary[]>([]);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [draft, setDraft] = useState<CourseSnapshot | null>(null);
  const build = overview?.build ?? null;
  const status = overview?.course.status ?? details?.status ?? "draft";
  const building = useAction();
  const publishing = useAction();

  const loadSources = useCallback(() => void call<OwnerSourceSummary[]>("sources").then(setSources), [call]);
  // The owner's preview shows chips for every cited file, opened with ownerSourcePage.
  const citations = useMemo<Citations>(
    () => ({
      sources: new Map(sources.map((s) => [s.id, { id: s.id, name: s.name, pages: s.pages }])),
      open: (source, page, passage) => onOpenSource({ source, page, passage, owner: true }),
    }),
    [sources, onOpenSource],
  );
  useEffect(() => {
    void call<CourseDetails>("details").then(setDetails);
    void call<ModelSettings>("modelSettings").then(setSettings);
    loadSources();
  }, [call, loadSources]);

  // The built course, once there is one to review (and again after each rebuild).
  const builtAt = build?.status === "done" ? build.finished_at : null;
  useEffect(() => {
    if (status !== "review" && status !== "published") return setDraft(null);
    void call<CourseSnapshot>("draft")
      .then(setDraft)
      .catch(() => setDraft(null));
  }, [call, status, builtAt]);

  const locked = status === "building" ? "Files can't change while the course builds." : status === "published" ? "A published course keeps its files: its lessons cite them." : null;
  const blocker =
    status === "published"
      ? "This course is published: it changes through releases now."
      : sources.length === 0
        ? "Add at least one file first."
        : !settings?.hasKey
          ? "Save a model key first."
          : null;

  if (!details || !settings) return <div className="empty">Loading the studio…</div>;

  return (
    <article className="page">
      <div className="eyebrow">Studio</div>
      <h1>{details.title}</h1>
      <p className="lede">
        {status === "published"
          ? "Published. Learners with the invite link can take it; the repair harness keeps improving it."
          : "Add your files and a model key, build the course, look it over, then publish it."}
      </p>

      <Card step={1} title="About the course" done={Boolean(details.goal)}>
        <Details call={call} details={details} onSaved={(d) => setDetails(d)} />
      </Card>

      <Card step={2} title="Files" done={sources.length > 0}>
        <Sources
          call={call}
          sources={sources}
          locked={locked}
          onChange={loadSources}
          onView={(s) => onOpenSource({ source: { id: s.id, name: s.name, pages: s.pages }, page: 1, owner: true })}
        />
      </Card>

      <Card step={3} title="Model key" done={settings.hasKey}>
        <ModelKey call={call} settings={settings} onChange={setSettings} />
      </Card>

      <Card step={4} title="Build" done={status === "review" || status === "published"}>
        <Build
          build={build}
          canBuild={!blocker}
          blocker={blocker}
          busy={building.busy}
          error={building.error}
          onBuild={() => void building.run(() => call("build"))}
        />
      </Card>

      {draft && (
        <Card step={5} title={status === "published" ? "The course" : "Review and publish"} done={status === "published"}>
          <Preview call={call} draft={draft} warnings={build?.warnings ?? []} citations={citations} />
          {status === "review" && (
            <div className="row" style={{ marginTop: "var(--s4)" }}>
              <button
                className="btn primary"
                disabled={publishing.busy}
                onClick={() => void publishing.run(async () => {
                  await call("publish");
                  onPublished();
                })}
              >
                {publishing.busy ? "Publishing…" : "Publish"}
              </button>
              <span className="small muted">Learners see it from then on. Later changes go through releases.</span>
            </div>
          )}
          {publishing.error && <div className="notice">{publishing.error}</div>}
        </Card>
      )}

      <Card step={draft ? 6 : 5} title="Share">
        <Share call={call} courseId={courseId} />
      </Card>

      <Card title="Delete course" danger>
        <DeleteCourse title={details.title} onDelete={onDelete} />
      </Card>
    </article>
  );
}
