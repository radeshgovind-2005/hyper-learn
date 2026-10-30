import { useState } from "react";
import { useNavigate } from "react-router";
import { AUDIENCE_LABEL, coursePath, type Directory } from "../directory.js";
import type { Audience } from "../types.js";

/** Who the course is for: the build explains more, or less, to match. Also on the studio's details form. */
export function AudienceField({ value, onChange }: { value: Audience; onChange: (a: Audience) => void }) {
  return (
    <label className="field">
      <span>Who it's for</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as Audience)}>
        {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((a) => (
          <option key={a} value={a}>
            {AUDIENCE_LABEL[a]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Step one of a new course: a title, a description and who it is for. Files, key and build follow on its studio page. */
export function CreateCourse({ directory }: { directory: Directory }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [audience, setAudience] = useState<Audience>("beginner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await directory.call<{ id: string }>("createCourse", [{ title, description, audience }]);
      directory.refresh();
      navigate(`${coursePath(id)}/studio`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <article className="page narrow">
      <div className="eyebrow">Studio</div>
      <h1>New course</h1>
      <p className="lede">Name it now. Next you add your files and build it; nobody else sees it until you publish.</p>
      <form
        className="stack card"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="field">
          <span>Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Parallel Computation" required autoFocus />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <textarea className="input text" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} placeholder="Who it's for and what it covers" />
        </label>
        <AudienceField value={audience} onChange={setAudience} />
        {error && <div className="notice">{error}</div>}
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy || !directory.ready || !title.trim()}>
            {busy ? "Creating…" : "Create course"}
          </button>
          <button className="btn quiet" type="button" onClick={() => navigate(-1)}>
            Cancel
          </button>
        </div>
      </form>
    </article>
  );
}
