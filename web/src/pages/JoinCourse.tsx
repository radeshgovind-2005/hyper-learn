import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { coursePath, type Directory } from "../directory.js";

/** An invite link (/join/<course>/<token>): joins as soon as the directory is connected, then opens the course. */
export function JoinCourse({ directory, courseId, token }: { directory: Directory; courseId: string; token: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (!directory.ready || tried.current) return;
    tried.current = true;
    directory
      .call<{ id: string }>("join", [courseId, token])
      .then(({ id }) => {
        directory.refresh();
        navigate(coursePath(id), { replace: true });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [directory, courseId, token, navigate]);

  return (
    <article className="page narrow">
      <h1>Joining the course…</h1>
      {error ? (
        <div className="stack">
          <div className="notice">{error}</div>
          <p className="small muted">Ask the course owner for a new link.</p>
          <div className="row">
            <button className="btn secondary" onClick={() => navigate("/")}>
              Go to the featured course
            </button>
          </div>
        </div>
      ) : (
        <p className="muted">One moment.</p>
      )}
    </article>
  );
}
