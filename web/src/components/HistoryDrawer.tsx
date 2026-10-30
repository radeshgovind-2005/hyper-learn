import { useState } from "react";
import type { Call, Overview, ReleaseSummary } from "../types.js";

const STATUS: Record<ReleaseSummary["status"], { chip: string; label: string }> = {
  live: { chip: "green", label: "Live" },
  trial: { chip: "blue", label: "In trial" },
  promoted: { chip: "", label: "Kept" },
  superseded: { chip: "", label: "Previous" },
  reverted: { chip: "red", label: "Reverted" },
  rejected: { chip: "amber", label: "Rejected" },
};

/** Every version of the course, newest first. Picking one shows it, with what it changed highlighted. */
export function HistoryDrawer({
  overview,
  viewing,
  onView,
  call,
  mayUndo = false,
}: {
  overview: Overview | null;
  viewing: string | null;
  onView: (version: string) => void;
  /** With `mayUndo`: the live release can be undone (released as its inverse, a new version). */
  call?: Call;
  mayUndo?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!overview) return null;
  const undo = async (version: string) => {
    if (!call) return;
    setBusy(true);
    setError(null);
    try {
      await call("undoRelease", [version]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // A kept trial and the release it became say the same thing: show the release, not both.
  const releases = overview.releases.filter((r) => r.status !== "promoted").reverse();
  return (
    <>
      <p className="small muted" style={{ margin: 0 }}>
        Every change to the course is a version. Trials that didn't prove themselves are kept here, reverted.
      </p>
      <ul className="history">
        {releases.map((r) => (
          <li key={r.version}>
            <button className={viewing === r.version ? "on" : ""} onClick={() => onView(r.version)}>
              <div className="row between">
                <span className="ver">v{r.version}</span>
                <span className={`chip ${STATUS[r.status].chip}`}>{STATUS[r.status].label}</span>
              </div>
              <div className="what">{r.changes.length > 0 ? r.changes.join("; ") : "The course as first published"}</div>
              {r.rationale && !r.decision && <div className="footnote" style={{ marginTop: 4 }}>{r.rationale}</div>}
              {r.decision && <div className="footnote" style={{ marginTop: 4 }}>{r.decision.reasons[0]}</div>}
            </button>
            {mayUndo && r.status === "live" && r.parent && r.changes.length > 0 && (
              <button className="btn quiet sm undo-btn" disabled={busy} onClick={() => void undo(r.version)}>
                Undo this release
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="notice">{error}</div>}
    </>
  );
}
