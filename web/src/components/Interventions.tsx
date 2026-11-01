import { useEffect, useMemo, useState } from "react";
import { evaluate, parseFormula } from "../expr.js";
import type { Intervention } from "../types.js";
import "../styles/viewer.css";

type CheckQuestion = Extract<Intervention, { template: "contrast" }>["check"];

/** A question with feedback on every option, shown after picking. Practice: never scored. */
function Check({ question, onAnswered }: { question: CheckQuestion; onAnswered?: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{question.prompt}</div>
      <div className="options">
        {question.options.map((option, i) => {
          const state = picked === null ? "" : option.correct ? "right" : picked === i ? "wrong" : "";
          return (
            <button
              key={i}
              className={`option ${state}`}
              onClick={() => {
                setPicked(i);
                onAnswered?.();
              }}
              disabled={picked !== null}
            >
              <span className="mark" aria-hidden>
                {state === "right" ? "✓" : state === "wrong" ? "✕" : ""}
              </span>
              <span>
                {option.text}
                {picked !== null && (picked === i || option.correct) && <div className="feedback">{option.feedback}</div>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Contrast({ intervention, onCompleted }: { intervention: Extract<Intervention, { template: "contrast" }>; onCompleted?: () => void }) {
  return (
    <div className="contrast">
      <div className="sides">
        <div className="side myth">
          <h4>What it can look like</h4>
          {intervention.belief}
        </div>
        <div className="side fact">
          <h4>What actually happens</h4>
          {intervention.what_actually_happens}
        </div>
      </div>
      <div className="why">
        <strong>Why it's tempting: </strong>
        {intervention.why_it_seems_right}
      </div>
      <div className="check">
        <Check question={intervention.check} {...(onCompleted && { onAnswered: onCompleted })} />
      </div>
    </div>
  );
}

function Practice({ intervention, onCompleted }: { intervention: Extract<Intervention, { template: "practice" }>; onCompleted?: () => void }) {
  const [, setAnswered] = useState(() => new Set<number>());
  const answer = (i: number) =>
    setAnswered((prev) => {
      const next = new Set(prev).add(i);
      if (next.size === intervention.questions.length) onCompleted?.();
      return next;
    });
  return (
    <div className="card" style={{ borderRadius: "var(--radius-lg)", padding: "var(--s5)" }}>
      <div className="eyebrow" style={{ marginBottom: "var(--s3)" }}>Practice · not scored</div>
      {intervention.questions.map((q, i) => (
        <div key={i} style={{ marginTop: i ? "var(--s5)" : 0 }}>
          <Check question={q} onAnswered={() => answer(i)} />
        </div>
      ))}
    </div>
  );
}

/** A frame-by-frame player of a message list: each step highlights what just changed. */
function StepThrough({ intervention, onCompleted }: { intervention: Extract<Intervention, { template: "step_through" }>; onCompleted?: () => void }) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = intervention.frames.length - 1;
  useEffect(() => {
    if (!playing) return;
    if (frame >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setFrame((f) => f + 1), 2200);
    return () => clearTimeout(timer);
  }, [playing, frame, last]);
  const current = intervention.frames[frame]!;
  useEffect(() => {
    if (frame === last) onCompleted?.();
  }, [frame, last, onCompleted]);

  return (
    <div className="player">
      <h4>{intervention.title}</h4>
      <div className="caption">
        Step {frame + 1} of {intervention.frames.length}: {current.caption}
      </div>
      <div className="messages">
        {current.messages.map((m, i) => (
          <div key={i} className={`msg ${current.highlight === i ? "hl" : ""}`}>
            <span className={`role ${m.role}`}>{m.role}</span>
            <span className="text">{m.text}</span>
          </div>
        ))}
      </div>
      <div className="controls">
        <button className="btn secondary sm" onClick={() => setFrame((f) => Math.max(0, f - 1))} disabled={frame === 0}>
          ← Back
        </button>
        <button
          className="btn primary sm"
          onClick={() => {
            if (frame >= last) setFrame(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? "Pause" : frame >= last ? "Replay" : "Play"}
        </button>
        <button className="btn secondary sm" onClick={() => setFrame((f) => Math.min(last, f + 1))} disabled={frame === last}>
          Next →
        </button>
        <div className="dots">
          {intervention.frames.map((_, i) => (
            <span key={i} className={i <= frame ? "on" : ""} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Points on the explorer's curve (CURVE_POINTS in src/interventions/checks.ts, which checks the same points). */
const CURVE_POINTS = 41;

const fmt = (n: number) => (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0) ? n.toPrecision(3) : String(Number(n.toFixed(2))));

/** A formula to play with: a slider per parameter, the curve over one of them, and the value at the sliders. */
function Explorer({ intervention, onCompleted }: { intervention: Extract<Intervention, { template: "explorer" }>; onCompleted?: () => void }) {
  const { parameters, plot } = intervention;
  const tree = useMemo(() => {
    try {
      return parseFormula(intervention.formula, parameters.map((p) => p.name));
    } catch {
      return null;
    }
  }, [intervention.formula, parameters]);
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(parameters.map((p) => [p.name, p.value])));
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (moved) onCompleted?.();
  }, [moved, onCompleted]);
  if (!tree) return <div className="notice">This formula can't be shown.</div>;

  const axis = parameters.find((p) => p.name === plot) ?? parameters[0]!;
  const curve = Array.from({ length: CURVE_POINTS }, (_, i) => {
    const x = axis.min + ((axis.max - axis.min) * i) / (CURVE_POINTS - 1);
    return { x, y: evaluate(tree, { ...values, [axis.name]: x }) };
  }).filter((p) => Number.isFinite(p.y));
  const result = evaluate(tree, values);
  const ys = curve.map((p) => p.y);
  const [lo, hi] = [Math.min(0, ...ys), Math.max(...ys, result)];
  const W = 320;
  const H = 160;
  const px = (x: number) => ((x - axis.min) / (axis.max - axis.min || 1)) * W;
  const py = (y: number) => H - ((y - lo) / (hi - lo || 1)) * H;
  const path = curve.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(" ");

  return (
    <div className="widget explorer">
      <h4>{intervention.title}</h4>
      <div className="explorer-body">
        <div className="sliders">
          {parameters.map((p) => (
            <label key={p.name} className="slider">
              <span className="row between small">
                <span>
                  {p.label} (<code>{p.name}</code>)
                </span>
                <strong>{fmt(values[p.name]!)}</strong>
              </span>
              <input
                type="range"
                min={p.min}
                max={p.max}
                step={p.step}
                value={values[p.name]}
                aria-valuetext={`${p.label}: ${fmt(values[p.name]!)}`}
                onChange={(e) => {
                  setValues((v) => ({ ...v, [p.name]: Number(e.target.value) }));
                  setMoved(true);
                }}
              />
            </label>
          ))}
          <div className="readout" aria-live="polite">
            {intervention.result_label}: <strong>{Number.isFinite(result) ? fmt(result) : "—"}</strong>
          </div>
          <div className="small muted">
            <code>{intervention.formula}</code>
          </div>
        </div>
        <svg className="curve" viewBox={`-8 -8 ${W + 16} ${H + 28}`} role="img" aria-label={`${intervention.result_label} as ${axis.label} goes from ${fmt(axis.min)} to ${fmt(axis.max)}`}>
          <line x1={0} y1={H} x2={W} y2={H} className="axis" />
          <line x1={0} y1={0} x2={0} y2={H} className="axis" />
          <path d={path} className="line" />
          {Number.isFinite(result) && <circle cx={px(values[axis.name]!)} cy={py(result)} r={5} className="dot" />}
          <text x={0} y={H + 16} className="tick">
            {fmt(axis.min)}
          </text>
          <text x={W} y={H + 16} className="tick" textAnchor="end">
            {fmt(axis.max)}
          </text>
          <text x={W / 2} y={H + 16} className="tick" textAnchor="middle">
            {axis.label}
          </text>
          <text x={4} y={8} className="tick">
            {fmt(hi)}
          </text>
        </svg>
      </div>
      <p className="takeaway">{intervention.takeaway}</p>
    </div>
  );
}

/** Two cases, one at a time behind a toggle, with their numbers side by side and the line that tells them apart. */
function Compare({ intervention, onCompleted }: { intervention: Extract<Intervention, { template: "compare" }>; onCompleted?: () => void }) {
  const [shown, setShown] = useState(0);
  const [seen, setSeen] = useState(() => new Set([0]));
  useEffect(() => {
    if (seen.size === intervention.cases.length) onCompleted?.();
  }, [seen, intervention.cases.length, onCompleted]);
  const current = intervention.cases[shown]!;
  const most = Math.max(...intervention.cases.map((c) => c.figure?.value ?? 0), 1e-9);
  return (
    <div className="widget compare">
      <h4>{intervention.title}</h4>
      <div className="row toggle" role="group" aria-label="Case">
        {intervention.cases.map((c, i) => (
          <button
            key={c.label}
            className={`btn sm ${shown === i ? "primary" : "secondary"}`}
            aria-pressed={shown === i}
            onClick={() => {
              setShown(i);
              setSeen((s) => new Set(s).add(i));
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      <ul className="case-points">
        {current.points.map((point, i) => (
          <li key={i}>{point}</li>
        ))}
      </ul>
      {intervention.cases.some((c) => c.figure) && (
        <div className="bars">
          {intervention.cases.map((c, i) =>
            c.figure ? (
              <div key={c.label} className={`bar-row ${i === shown ? "on" : ""}`}>
                <span className="small">{c.label}</span>
                <span className="bar" style={{ width: `${Math.max(2, (c.figure.value / most) * 100)}%` }} />
                <span className="small">
                  {c.figure.label}: {fmt(c.figure.value)} {c.figure.unit}
                </span>
              </div>
            ) : null,
          )}
        </div>
      )}
      <p className="takeaway">{intervention.takeaway}</p>
    </div>
  );
}

/** Renders an intervention. `track`, when given, hears "shown" on first render and "completed" when the learner finishes it. */
export function InterventionView({ intervention, track }: { intervention: Intervention; track?: (event: "shown" | "completed") => void }) {
  useEffect(() => track?.("shown"), [track]);
  const onCompleted = useMemo(() => (track ? () => track("completed") : undefined), [track]);
  const done = onCompleted ? { onCompleted } : {};
  switch (intervention.template) {
    case "contrast":
      return <Contrast intervention={intervention} {...done} />;
    case "practice":
      return <Practice intervention={intervention} {...done} />;
    case "step_through":
      return <StepThrough intervention={intervention} {...done} />;
    case "explorer":
      return <Explorer intervention={intervention} {...done} />;
    case "compare":
      return <Compare intervention={intervention} {...done} />;
  }
}
