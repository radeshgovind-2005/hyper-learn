import { useEffect, useState } from "react";
import type { Call } from "../types.js";

// What learners keep asking the study coach to repair, and whether the personal lessons worked. One
// click turns a pattern into an owner edit for everyone (the same "Ask for a change" engine).

interface Insight {
  key: string;
  target: { kind: string; id?: string; lesson: string };
  label: string;
  learners: number;
  repaired: number;
  fixed: number;
  approaches: Record<string, { tried: number; fixed: number }>;
}

const APPROACH: Record<string, string> = { refute: "a refutation (name the mix-up, then correct it)", worked_example: "a worked example", smaller_steps: "smaller steps" };

/** The request the editor gets: what learners struggle with, and what helped them one by one. */
function instruction(i: Insight): string {
  const best = Object.entries(i.approaches)
    .filter(([, a]) => a.fixed > 0)
    .sort(([, a], [, b]) => b.fixed / b.tried - a.fixed / a.tried)[0]?.[0];
  const what =
    i.target.kind === "misconception"
      ? `Learners keep holding this mix-up: ${i.label.replace(/^Mix-up: /, "")}. Address it where it's taught: name the belief, say why it seems right, and show why it's wrong.`
      : i.target.kind === "gap"
        ? `Learners keep missing an idea from an earlier lesson (${i.label}). Make the link explicit where the later lesson relies on it, with a short recap.`
        : `Learners struggle with: ${i.label}. Explain it more clearly where it's taught.`;
  return `${what}${best ? ` In personal lessons, ${APPROACH[best] ?? best} worked best.` : ""} Add a question or two that checks it.`;
}

export function CoachInsights({ call, busy }: { call: Call; busy: boolean }) {
  const [rows, setRows] = useState<Insight[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => {
    void call<Insight[]>("coachInsights")
      .then(setRows)
      .catch(() => setRows([]));
  }, [call]);
  if (!rows || rows.length === 0) return <p className="small muted">When learners use the study coach, what they keep needing repaired shows up here.</p>;
  return (
    <div className="stack">
      <ul className="coach-insights">
        {rows.slice(0, 6).map((r) => (
          <li key={r.key}>
            <span className="grow">
              <strong>{r.label}</strong>
              <span className="small muted">
                {" "}
                · {r.learners} learner{r.learners === 1 ? "" : "s"}
                {r.repaired > 0 ? ` · personal lessons fixed it ${r.fixed} of ${r.repaired} times` : ""}
              </span>
            </span>
            <button
              className="btn secondary sm"
              disabled={busy || sent === r.key}
              onClick={() => {
                setError(null);
                void call("requestEdit", [{ kind: "ask", instruction: instruction(r) }])
                  .then(() => setSent(r.key))
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
              }}
            >
              {sent === r.key ? "Proposal on its way" : "Fix it for everyone"}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className="notice">{error}</div>}
    </div>
  );
}
