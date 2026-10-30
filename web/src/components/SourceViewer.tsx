import { useEffect, useMemo, useRef, useState } from "react";
import { findPassage } from "../passage.js";
import type { Call, CitedSource, SourcePage } from "../types.js";

/** A source page to open: from a lesson's citation chip, or from the studio's file list. */
export interface SourceTarget {
  source: CitedSource;
  page: number;
  /** The lesson text the reader came from: the page's best match for it is highlighted. */
  passage?: string;
  /** The owner's view (any file, any page) instead of a learner's (only files lessons cite). */
  owner: boolean;
}

/**
 * One page of an uploaded file, as text, with paging. The server decides what may be read: learners get
 * the files their lessons cite (sourcePage), owners every file (ownerSourcePage).
 */
export function SourceViewer({ call, target }: { call: Call; target: SourceTarget }) {
  const [page, setPage] = useState(target.page);
  const [loaded, setLoaded] = useState<SourcePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mark = useRef<HTMLElement>(null);
  const total = target.source.pages;

  useEffect(() => {
    let current = true;
    setError(null);
    call<SourcePage>(target.owner ? "ownerSourcePage" : "sourcePage", [target.source.id, page])
      .then((p) => current && setLoaded(p))
      .catch((e: unknown) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      current = false;
    };
  }, [call, target.owner, target.source.id, page]);

  const shown = loaded?.page === page && loaded.source.id === target.source.id ? loaded : null;
  const passage = useMemo(() => (shown ? findPassage(shown.text, target.passage) : null), [shown, target.passage]);
  useEffect(() => {
    mark.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [passage]);

  let body;
  if (error) body = <div className="notice">{error}</div>;
  else if (!shown || !passage) body = <div className="small muted">Loading the page…</div>;
  else if (!shown.text.trim()) body = <div className="small muted">This page has no text (it may be a picture or a scan).</div>;
  else if (!passage.marked) body = <div className="source-page">{shown.text}</div>;
  else {
    const [first, last] = passage.marked;
    body = (
      <div className="source-page">
        {passage.pieces.slice(0, first).join("")}
        <mark ref={mark} className="source-mark">
          {passage.pieces.slice(first, last + 1).join("")}
        </mark>
        {passage.pieces.slice(last + 1).join("")}
      </div>
    );
  }

  return (
    <div className="stack source-viewer">
      <div className="row between">
        <span className="small muted" aria-live="polite">
          Page {page} of {total}
        </span>
        <div className="row">
          <button className="btn secondary sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </button>
          <button className="btn secondary sm" disabled={page >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </button>
        </div>
      </div>
      {body}
      {passage?.marked && <p className="small muted">Highlighted: the lines that share the most words with the lesson text you came from.</p>}
    </div>
  );
}
