import { useState } from "react";
import type { ApprovalRequest, ApprovalResponse, Call, Overview, ReleaseSummary, RunState, RunStep } from "../types.js";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => `${v > 0 ? "+" : ""}${pct(v)}`;

// The loop, as stages a person can follow at a glance. Each graph node belongs to one stage.
const STAGES = [
  { name: "Propose", nodes: ["curator"] },
  { name: "Review", nodes: ["reflection"] },
  { name: "Author", nodes: ["author", "review_content"] },
  { name: "Release", nodes: ["plan_release"] },
  { name: "Approve", nodes: ["approve"] },
  { name: "Trial", nodes: ["measure", "decide"] },
] as const;

type StageState = "pending" | "current" | "done" | "failed" | "skipped";

function stageStates(run: RunState): StageState[] {
  const lastIndex = STAGES.reduce((last, stage, i) => (run.steps.some((s) => (stage.nodes as readonly string[]).includes(s.node)) ? i : last), -1);
  return STAGES.map((stage, i) => {
    const steps = run.steps.filter((s) => (stage.nodes as readonly string[]).includes(s.node));
    if (steps.some((s) => s.status === "waiting")) return "current";
    if (steps.length === 0) {
      if (run.status === "running" && i === lastIndex + 1) return "current";
      // Only interventions need authoring; other proposals go straight to release.
      return stage.name === "Author" && lastIndex > i ? "skipped" : "pending";
    }
    const finalStep = steps.at(-1)!;
    if (i === lastIndex && run.status !== "running" && (finalStep.status === "rejected" || finalStep.status === "info")) {
      return finalStep.status === "rejected" ? "failed" : "done";
    }
    return "done";
  });
}

function headline(run: RunState | undefined, outcome: ReleaseSummary | undefined): { title: string; sub: string } {
  if (!run) return { title: "No run yet", sub: "Pick the learner data below and run the loop." };
  if (run.status === "running") return { title: "Working…", sub: run.steps.at(-1)?.title ?? "Reading the learner data" };
  if (run.status === "awaiting_approval") return { title: "Waiting for your approval", sub: "Nothing changes for learners until you approve and the trial passes." };
  if (run.status === "error") return { title: "The run failed", sub: run.error ?? "" };
  const last = run.steps.at(-1);
  if (last?.node === "decide" && outcome?.decision) {
    return outcome.decision.verdict === "keep"
      ? { title: `Kept · v${outcome.promoted_to ?? outcome.version} is live`, sub: "The change did what it claimed, and nothing else got worse." }
      : { title: `Reverted · v${outcome.parent} stays live`, sub: "The trial didn't show the change worked, so learners never get it." };
  }
  if (last?.node === "approve") return { title: "Rejected · nothing changed", sub: last.detail ?? "You declined the release." };
  return { title: last?.title ?? "Done", sub: last?.detail?.split("\n")[0] ?? "" };
}

function Stepper({ run }: { run: RunState | undefined }) {
  const states: StageState[] = run ? stageStates(run) : STAGES.map(() => "pending");
  return (
    <div className="stepper" role="list" aria-label="Run progress">
      {STAGES.map((stage, i) => {
        const state = states[i]!;
        if (state === "skipped") return null;
        return (
          <div key={stage.name} role="listitem" className={`stage ${state}`} aria-current={state === "current" ? "step" : undefined}>
            <span className="node">{state === "done" ? "✓" : state === "failed" ? "✕" : state === "current" ? <span className="spinner" /> : ""}</span>
            {stage.name}
          </div>
        );
      })}
    </div>
  );
}

function Approval({ request, onAnswer }: { request: ApprovalRequest; onAnswer: (r: ApprovalResponse) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = (approved: boolean) => {
    setBusy(true);
    onAnswer({ approved, ...(note && { note }) });
  };
  return (
    <section className="approval stack" aria-label="Approval">
      <div className="row between">
        <span className="version">
          v{request.parent} → v{request.version}
        </span>
        <span className="row">
          <span className={`chip ${request.tier === "R2" ? "red" : request.tier === "R1" ? "amber" : "green"}`}>risk {request.tier}</span>
          <span className="chip">{request.bump}</span>
        </span>
      </div>
      <ul>
        {request.changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="why">{request.rationale}</div>
      {request.escalated && <div className="why">Autopilot can't approve this one: {request.escalated}.</div>}
      <input className="input" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => answer(true)}>
          Approve trial
        </button>
        <button className="btn danger" disabled={busy} onClick={() => answer(false)}>
          Reject
        </button>
      </div>
      <div className="footnote">Approving starts a trial, not a release. It's kept only if the measurement shows it worked.</div>
    </section>
  );
}

function Verdict({ release }: { release: ReleaseSummary }) {
  const m = release.measurement!;
  const p = m.primary;
  const keep = release.decision?.verdict === "keep";
  const metric = p.metric === "fail_rate" ? `${p.lesson} fail rate` : "learners still holding the belief";
  return (
    <section className={`verdict ${keep ? "keep" : "revert"}`} aria-label="Trial result">
      <div className="small muted">{metric}, on their retake</div>
      <div className="bars">
        {[
          { label: `Without it (v${release.parent})`, rate: p.control.rate, n: p.control.attempts, color: "#8a8d91" },
          { label: `With it (v${release.version})`, rate: p.treatment.rate, n: p.treatment.attempts, color: keep ? "var(--green)" : "var(--red)" },
        ].map((b) => (
          <div key={b.label} className="bar">
            <div className="label">
              <span>{b.label}</span>
              <strong>
                {pct(b.rate)} <span className="muted">of {b.n}</span>
              </strong>
            </div>
            <div className="track">
              <div className="fill" style={{ width: pct(b.rate), background: b.color }} />
            </div>
          </div>
        ))}
      </div>
      <div className="small">
        Difference {signed(p.diff)} · 95% CI {signed(p.diff_ci[0])} to {signed(p.diff_ci[1])}
      </div>
    </section>
  );
}

const WHO: Record<RunStep["actor"], string> = { agent: "✦", code: "⚙", human: "✋" };

function Activity({ steps, running }: { steps: RunStep[]; running: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="activity">
      {steps.map((step, i) => (
        <div key={i}>
          <button className={`act ${step.status}`} onClick={() => setOpen(open === i ? null : i)} disabled={!step.detail} aria-expanded={open === i}>
            <span className={`who ${step.actor}`} title={step.actor}>
              {step.status === "waiting" ? <span className="spinner" /> : WHO[step.actor]}
            </span>
            <span className="text">{step.title}</span>
          </button>
          {open === i && step.detail && <div className="detail">{step.detail}</div>}
        </div>
      ))}
      {running && (
        <div className="act">
          <span className="who code">
            <span className="spinner" />
          </span>
          <span className="text muted">Working…</span>
        </div>
      )}
    </div>
  );
}

/** The admin key, kept for this browser session only (when storage allows). */
function savedKey(): string {
  try {
    return sessionStorage.getItem("hyperlearn-admin") ?? "";
  } catch {
    return "";
  }
}
function saveKey(key: string) {
  try {
    sessionStorage.setItem("hyperlearn-admin", key);
  } catch {
    // Storage unavailable: the key lives in memory for this page only.
  }
}

export function RepairDrawer({ overview, call, onReset, onView }: { overview: Overview | null; call: Call; onReset: () => void; onView: (v: string | null) => void }) {
  const [adminKey, setAdminKey] = useState(savedKey);
  const [mode, setMode] = useState<"hitl" | "autopilot">("hitl");
  const [agents, setAgents] = useState(false);
  const [scenario, setScenario] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!overview) return <div className="empty">Connecting to the course…</div>;

  const run = overview.run ?? undefined;
  const running = run?.status === "running";
  const waiting = run?.status === "awaiting_approval";
  const selected = scenario ?? overview.scenario;
  const chosen = overview.scenarios.find((s) => s.id === selected);
  const outcome = overview.releases.filter((r) => r.measurement && !r.released_from).at(-1);
  const showOutcome = run?.status === "done" && run.steps.at(-1)?.node === "decide" && outcome;
  const { title, sub } = headline(run, outcome);
  const act = (p: Promise<unknown>) => p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const start = () => {
    setError(null);
    const reset = selected !== overview.scenario ? call("reset", [selected, adminKey]).then(onReset) : Promise.resolve();
    void act(reset.then(() => call("startRun", [mode, agents, adminKey])));
  };

  return (
    <>
      <section aria-live="polite">
        <Stepper run={run} />
        <div className="headline">{title}</div>
        <div className="headline-sub">{sub}</div>
      </section>

      {waiting && run.approval && <Approval request={run.approval} onAnswer={(r) => void act(call("approve", [r, adminKey]))} />}

      {showOutcome && (
        <>
          <Verdict release={outcome} />
          <button className="btn quiet sm" style={{ alignSelf: "flex-start" }} onClick={() => onView(outcome.decision?.verdict === "keep" ? null : outcome.version)}>
            {outcome.decision?.verdict === "keep" ? "See it in the lesson →" : `See what v${outcome.version} would have changed →`}
          </button>
        </>
      )}

      {error && <div className="notice">{error}</div>}

      {run && run.steps.length > 0 && (
        <details className="disclosure" open={running || waiting}>
          <summary>
            <span className="caret">›</span> Activity · {run.steps.length} steps · {run.agents ? "Muse Spark" : "reference stand-ins"}
          </summary>
          <Activity steps={run.steps} running={running} />
        </details>
      )}

      <details className="disclosure card soft" open={!run || (overview.adminRequired && !adminKey)}>
        <summary>
          <span className="caret">›</span> Run settings
          <span className="muted" style={{ fontWeight: 400, marginLeft: "auto" }}>
            {mode === "hitl" ? "You approve" : "Autopilot"} · {agents ? "Muse Spark" : "Reference"}
          </span>
        </summary>
        <div className="stack" style={{ marginTop: "var(--s4)" }}>
          {overview.adminRequired && (
            <label className="field">
              <span>Admin key</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={adminKey}
                onChange={(e) => {
                  setAdminKey(e.target.value);
                  saveKey(e.target.value);
                }}
              />
              <span className="footnote">Needed to change the course. Learners don't need it.</span>
            </label>
          )}
          <label className="field">
            <span>Learner data (simulated)</span>
            <select className="input" value={selected} onChange={(e) => setScenario(e.target.value)}>
              {overview.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          {chosen && <div className="small muted">{chosen.description}</div>}
          <div className="field">
            <span>Who approves</span>
            <div className="segmented">
              <button className={mode === "hitl" ? "on" : ""} onClick={() => setMode("hitl")}>
                You
              </button>
              <button className={mode === "autopilot" ? "on" : ""} onClick={() => setMode("autopilot")}>
                Autopilot
              </button>
            </div>
            {mode === "autopilot" && <span className="footnote">Up to risk R1. Drastic changes still come to you.</span>}
          </div>
          <div className="field">
            <span>Who proposes and writes</span>
            <div className="segmented">
              <button className={!agents ? "on" : ""} onClick={() => setAgents(false)}>
                Reference
              </button>
              <button className={agents ? "on" : ""} disabled={!overview.agentsAvailable} onClick={() => setAgents(true)}>
                Muse Spark
              </button>
            </div>
            {!overview.agentsAvailable && <span className="footnote">No model key set: a rule-based Curator and hand-written content stand in. Everything after is the real harness.</span>}
          </div>
        </div>
      </details>

      <div className="row">
        <button className="btn primary" disabled={running || waiting} onClick={start}>
          {running ? "Running…" : "Run repair"}
        </button>
        <button
          className="btn quiet"
          disabled={running}
          onClick={() => {
            setError(null);
            void act(call("reset", [selected, adminKey]).then(onReset));
          }}
        >
          Reset to v1.0.0
        </button>
      </div>

      <p className="footnote">
        Trial learners are simulated. A kept change shows the harness targets, applies and measures correctly, not that the content teaches real
        people.
      </p>
    </>
  );
}
