import { useState } from "react";
import { useNavigate } from "react-router";
import { coursePath, type Directory } from "../directory.js";

/** Step one of a new course: a title and a description. Files, key and build follow on its studio page. */
export function CreateCourse({ directory }: { directory: Directory }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await directory.call<{ id: string }>("createCourse", [{ title, description }]);
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
