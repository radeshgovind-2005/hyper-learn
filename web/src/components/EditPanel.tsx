import { marked } from "marked";
import { useState } from "react";
import type { Call, EditPreset, EditRequest, EditState, EditSummaryItem } from "../types.js";

// Owner edits in the UI: ask for a change in your own words, tune one section with a preset, follow the
// agents while they prepare it, then review the exact before/after and apply or discard it. The server
// checks permissions and refuses a stale proposal; this only lays it out.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const html = (markdown: string) => ({ __html: marked.parse(markdown, { async: false }) as string });

/** The presets the server knows (src/edit/types.ts EDIT_PRESETS), with the evidence each rests on. */
export const PRESETS: { id: EditPreset; label: string; why: string }[] = [
  { id: "worked_example", label: "Add a worked example", why: "Worked examples help newcomers most" },
  { id: "smaller_steps", label: "Smaller steps", why: "Segmenting: one idea at a time" },
  { id: "conversational", label: "More conversational", why: "Personalization: a friendly voice helps learning" },
  { id: "key_idea", label: "Lead with the key idea", why: "Signaling: highlight what matters" },
  { id: "plainer", label: "Plainer language", why: "Shorter sentences, defined terms" },
  { id: "practice", label: "Harder practice question", why: "Practice that applies the idea, not recalls it" },
];

async function request(call: Call, body: EditRequest, setError: (e: string | null) => void) {
  setError(null);
  try {
    await call("requestEdit", [body]);
    return true;
  } catch (e) {
    setError(message(e));
    return false;
  }
}

/** "Ask for a change": the request in the owner's words. */
export function AskForm({ call, busy, placeholder }: { call: Call; busy: boolean; placeholder?: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void request(call, { kind: "ask", instruction: text }, setError).then((ok) => ok && setText(""));
      }}
    >
      <textarea
        className="input text"
        rows={3}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? "e.g. Lesson 3 moves too fast: add a worked example of Amdahl's law, and more questions on speedup."}
        aria-label="What would you like to change?"
      />
      {error && <div className="notice">{error}</div>}
      <div className="row">
        <button className="btn primary sm" type="submit" disabled={busy || text.trim().length < 3}>
          Ask for this change
        </button>
        <span className="small muted">Agents propose the change from your files; you review it before anything changes.</span>
      </div>
    </form>
  );
}

/** "Tune" on one section: pick a preset, add your own words, or both. */
export function TuneForm({ call, sectionId, busy, onDone }: { call: Call; sectionId: string; busy: boolean; onDone?: () => void }) {
  const [preset, setPreset] = useState<EditPreset | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="tune stack">
      <div className="tune-presets" role="group" aria-label="How to tune this section">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={`chip-btn ${preset === p.id ? "on" : ""}`} aria-pressed={preset === p.id} title={p.why} onClick={() => setPreset(preset === p.id ? null : p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <input className="input" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Or say it yourself: e.g. use a pizza-delivery analogy" aria-label="Your own words" />
      {error && <div className="notice">{error}</div>}
      <div className="row">
        <button
          className="btn primary sm"
          disabled={busy || (!preset && !text.trim())}
          onClick={() =>
            void request(call, { kind: "tune", section_id: sectionId, ...(preset && { preset }), ...(text.trim() && { instruction: text.trim() }) }, setError).then((ok) => ok && onDone?.())
          }
        >
          Tune this section
        </button>
      </div>
    </div>
  );
}

function describe(request: EditRequest, sourceName?: (id: string) => string | undefined): string {
  if (request.kind === "ask") return `“${request.instruction}”`;
  if (request.kind === "add_source") return `What ${sourceName?.(request.source_id) ?? "the new file"} adds${request.instruction ? `: “${request.instruction}”` : ""}`;
  const preset = PRESETS.find((p) => p.id === request.preset)?.label;
  return `Tune: ${[preset, request.instruction && `“${request.instruction}”`].filter(Boolean).join(" + ")}`;
}

const KIND_LABEL: Record<EditSummaryItem["kind"], string> = { rewrite: "Rewrite", new_section: "New section", new_lesson: "New lesson", new_questions: "New questions" };

function Change({ item }: { item: EditSummaryItem }) {
  const [open, setOpen] = useState(item.kind !== "new_lesson");
  return (
    <div className="change">
      <div className="change-head">
        <span className="chip violet">{KIND_LABEL[item.kind]}</span>
        <span className="grow">
          <strong>{item.title}</strong>
          {item.lesson !== item.title && <span className="small muted"> · {item.lesson}</span>}
          {item.questions ? <span className="small muted"> · {item.questions} questions</span> : null}
        </span>
        {(item.before || item.after) && (
          <button className="btn quiet sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {item.warnings && item.warnings.length > 0 && (
        <div className="notice small">
          <span>
            The fact check still doubts: {item.warnings.slice(0, 3).join("; ")}
          </span>
        </div>
      )}
      {open && (
        <div className={`diff ${item.before ? "two" : ""}`}>
          {item.before && (
            <div className="diff-side before">
              <div className="eyebrow">Now</div>
              <div className="prose" dangerouslySetInnerHTML={html(item.before)} />
            </div>
          )}
          {item.after && (
            <div className="diff-side after">
              <div className="eyebrow">{item.before ? "Proposed" : "New"}</div>
              <div className="prose" dangerouslySetInnerHTML={html(item.after)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The current edit: progress while the agents work, the proposal to review once it's ready, or why it
 * failed. `published` says what applying means (a new release, or the draft).
 */
export function EditStatus({ call, edit, published, sourceName }: { call: Call; edit: EditState | null; published: boolean; sourceName?: (id: string) => string | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!edit || edit.status === "discarded") return null;
  const act = async (method: string, args: unknown[]) => {
    setBusy(true);
    setError(null);
    try {
      await call(method, args);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const last = edit.steps.at(-1);

  return (
    <div className={`edit-status ${edit.status}`} aria-live="polite">
      <div className="small muted">{describe(edit.request, sourceName)}</div>
      {edit.status === "running" && (
        <div className="row small">
          <span className="spinner" />
          <span>{last ? last.title : "Reading your course…"}</span>
        </div>
      )}
      {edit.status === "failed" && (
        <div className="notice stack">
          <strong>No change proposed</strong>
          <span>{edit.problems?.slice(0, 3).join(" · ")}</span>
          <div className="row">
            <button className="btn quiet sm" disabled={busy} onClick={() => void act("discardEdit", [])}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {edit.status === "applied" && (
        <div className="notice">
          <span className="grow">{edit.applied_as === "draft" ? "Applied to the draft." : `Released as v${edit.applied_as}: learners see it now.`}</span>
          <button className="btn quiet sm" disabled={busy} onClick={() => void act("discardEdit", [])}>
            OK
          </button>
        </div>
      )}
      {edit.status === "ready" && edit.proposal && (
        <div className="stack">
          {edit.proposal.reply && <p className="proposal-reply">{edit.proposal.reply}</p>}
          {edit.proposal.summary.map((item, i) => (
            <Change key={i} item={item} />
          ))}
          {edit.warnings && edit.warnings.length > 0 && (
            <ul className="small muted">
              {edit.warnings.slice(0, 5).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="row">
            <button className="btn primary sm" disabled={busy} onClick={() => void act("applyEdit", [edit.id])}>
              {published ? "Apply as a new release" : "Apply to the draft"}
            </button>
            <button className="btn quiet sm" disabled={busy} onClick={() => void act("discardEdit", [])}>
              Discard
            </button>
            {edit.model_calls ? <span className="small muted">{edit.model_calls} model calls</span> : null}
          </div>
        </div>
      )}
      {error && <div className="notice">{error}</div>}
    </div>
  );
}
