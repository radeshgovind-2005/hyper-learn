import { useEffect, useState } from "react";
import type { Intervention } from "../types.js";

type CheckQuestion = Extract<Intervention, { template: "contrast" }>["check"];

/** A question with feedback on every option, shown after picking. Practice: never scored. */
function Check({ question }: { question: CheckQuestion }) {
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{question.prompt}</div>
      <div className="options">
        {question.options.map((option, i) => {
          const state = picked === null ? "" : option.correct ? "right" : picked === i ? "wrong" : "";
          return (
            <button key={i} className={`option ${state}`} onClick={() => setPicked(i)} disabled={picked !== null}>
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

function Contrast({ intervention }: { intervention: Extract<Intervention, { template: "contrast" }> }) {
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
        <Check question={intervention.check} />
      </div>
    </div>
  );
}

function Practice({ intervention }: { intervention: Extract<Intervention, { template: "practice" }> }) {
  return (
    <div className="card" style={{ borderRadius: "var(--radius-lg)", padding: "var(--s5)" }}>
      <div className="eyebrow" style={{ marginBottom: "var(--s3)" }}>Practice · not scored</div>
      {intervention.questions.map((q, i) => (
        <div key={i} style={{ marginTop: i ? "var(--s5)" : 0 }}>
          <Check question={q} />
        </div>
      ))}
    </div>
  );
}

/** A frame-by-frame player of a message list: each step highlights what just changed. */
function StepThrough({ intervention }: { intervention: Extract<Intervention, { template: "step_through" }> }) {
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

export function InterventionView({ intervention }: { intervention: Intervention }) {
  switch (intervention.template) {
    case "contrast":
      return <Contrast intervention={intervention} />;
    case "practice":
      return <Practice intervention={intervention} />;
    case "step_through":
      return <StepThrough intervention={intervention} />;
  }
}
