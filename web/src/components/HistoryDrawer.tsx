import type { Overview, ReleaseSummary } from "../types.js";

const STATUS: Record<ReleaseSummary["status"], { chip: string; label: string }> = {
  live: { chip: "green", label: "Live" },
  trial: { chip: "blue", label: "In trial" },
  promoted: { chip: "", label: "Kept" },
  superseded: { chip: "", label: "Previous" },
  reverted: { chip: "red", label: "Reverted" },
  rejected: { chip: "amber", label: "Rejected" },
};

/** Every version of the course, newest first. Picking one shows it, with what it changed highlighted. */
export function HistoryDrawer({ overview, viewing, onView }: { overview: Overview | null; viewing: string | null; onView: (version: string) => void }) {
  if (!overview) return null;
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
              {r.decision && <div className="footnote" style={{ marginTop: 4 }}>{r.decision.reasons[0]}</div>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
