import { useMemo, useState } from "react";
import type { Certainty, QuizItem, Response } from "../types.js";

// Renders every quiz item type and collects responses in the shape the graders expect
// (src/assessment/items.ts). Orders are shuffled for display, deterministically per item.

function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const random = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = Math.imul(h ^ (h >>> 15), h | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const move = <T,>(list: T[], i: number, by: number) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

const TYPE_LABEL: Record<QuizItem["type"], string> = {
  single_choice: "Choose one",
  multi_select: "Choose all that apply",
  two_tier: "Answer, then say why",
  ordering: "Put in order",
  matching: "Match",
  cloze: "Fill in the blank",
  parsons: "Build the code",
  schema_completion: "Write the JSON",
  short_answer: "Explain in your own words",
};

/** The response an item starts with, before the learner touches it (undefined = not answered yet). */
export function initialResponse(item: QuizItem): Response | undefined {
  switch (item.type) {
    case "ordering":
      return seededShuffle(range(item.steps.length), item.id);
    case "matching":
      return item.left.map(() => -1);
    case "cloze":
      return item.blanks.map(() => "");
    case "parsons":
      return [];
    case "multi_select":
      return [];
    default:
      return undefined;
  }
}

export function isAnswered(item: QuizItem, response: Response | undefined): boolean {
  if (response === undefined) return false;
  switch (item.type) {
    case "two_tier":
      return Array.isArray(response) && (response as number[]).every((v) => v >= 0);
    case "matching":
      return (response as number[]).every((v) => v >= 0);
    case "cloze":
      return (response as string[]).every((v) => v.trim() !== "");
    case "multi_select":
    case "parsons":
      return (response as number[]).length > 0;
    case "schema_completion":
    case "short_answer":
      return typeof response === "string" && response.trim() !== "";
    default:
      return true;
  }
}

function Options({ texts, picked, onPick, multi }: { texts: string[]; picked: number[]; onPick: (i: number) => void; multi?: boolean }) {
  return (
    <div className="options" role={multi ? "group" : "radiogroup"}>
      {texts.map((text, i) => {
        const on = picked.includes(i);
        return (
          <button key={i} className={`option ${on ? "picked" : ""}`} onClick={() => onPick(i)} role={multi ? "checkbox" : "radio"} aria-checked={on}>
            <span className={`mark ${multi ? "square" : ""}`} aria-hidden>
              {multi && on ? "✓" : ""}
            </span>
            <span>{text}</span>
          </button>
        );
      })}
    </div>
  );
}

function ItemInput({ item, value, onChange }: { item: QuizItem; value: Response | undefined; onChange: (r: Response) => void }) {
  const shuffledRight = useMemo(() => (item.type === "matching" ? seededShuffle(range(item.right.length), item.id) : []), [item]);
  const parsonsPool = useMemo(
    () => (item.type === "parsons" ? seededShuffle(range(item.lines.length + item.distractors.length), item.id) : []),
    [item],
  );

  switch (item.type) {
    case "single_choice":
      return <Options texts={item.options.map((o) => o.text)} picked={value === undefined ? [] : [value as number]} onPick={onChange} />;
    case "multi_select": {
      const picked = (value as number[] | undefined) ?? [];
      return (
        <Options
          multi
          texts={item.options.map((o) => o.text)}
          picked={picked}
          onPick={(i) => onChange(picked.includes(i) ? picked.filter((x) => x !== i) : [...picked, i])}
        />
      );
    }
    case "two_tier": {
      const [a, r] = (value as number[] | undefined) ?? [-1, -1];
      return (
        <>
          <Options texts={item.options.map((o) => o.text)} picked={[a!]} onPick={(i) => onChange([i, r!])} />
          <div className="sub">{item.reason_prompt}</div>
          <Options texts={item.reasons.map((o) => o.text)} picked={[r!]} onPick={(i) => onChange([a!, i])} />
        </>
      );
    }
    case "ordering": {
      const order = value as number[];
      return (
        <div className="list">
          {order.map((step, i) => (
            <div key={step} className="list-item">
              <span className="muted small">{i + 1}.</span>
              <span className="grow">{item.steps[step]}</span>
              <button className="icon-btn" aria-label="Move up" onClick={() => onChange(move(order, i, -1))}>↑</button>
              <button className="icon-btn" aria-label="Move down" onClick={() => onChange(move(order, i, 1))}>↓</button>
            </div>
          ))}
        </div>
      );
    }
    case "matching": {
      const chosen = value as number[];
      return (
        <div>
          {item.left.map((left, i) => (
            <div key={i} className="match">
              <strong>{left}</strong>
              <select className="input" value={chosen[i]} onChange={(e) => onChange(chosen.map((v, j) => (j === i ? Number(e.target.value) : v)))}>
                <option value={-1}>Choose…</option>
                {shuffledRight.map((r) => (
                  <option key={r} value={r}>
                    {item.right[r]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      );
    }
    case "cloze": {
      const answers = value as string[];
      const parts = item.text.split(/(\{\{\d+\}\})/);
      return (
        <div className="cloze">
          {parts.map((part, i) => {
            const hole = /\{\{(\d+)\}\}/.exec(part);
            if (!hole) return <span key={i}>{part}</span>;
            const b = Number(hole[1]);
            return (
              <input
                key={i}
                className="input"
                value={answers[b]}
                aria-label={`Blank ${b + 1}`}
                onChange={(e) => onChange(answers.map((v, j) => (j === b ? e.target.value : v)))}
              />
            );
          })}
        </div>
      );
    }
    case "parsons": {
      const chosen = value as number[];
      const text = (id: number) => (id < item.lines.length ? item.lines[id] : item.distractors[id - item.lines.length]!.text);
      return (
        <div>
          <div className="sub small">Your program</div>
          <div className="list">
            {chosen.length === 0 && <div className="muted small">Click a line below to add it.</div>}
            {chosen.map((id, i) => (
              <div key={id} className="list-item code">
                <span className="grow">{text(id)}</span>
                <button className="icon-btn" aria-label="Move up" onClick={() => onChange(move(chosen, i, -1))}>↑</button>
                <button className="icon-btn" aria-label="Move down" onClick={() => onChange(move(chosen, i, 1))}>↓</button>
                <button className="icon-btn" aria-label="Remove" onClick={() => onChange(chosen.filter((x) => x !== id))}>✕</button>
              </div>
            ))}
          </div>
          <div className="sub small">Available lines · not all of them belong</div>
          <div className="list">
            {parsonsPool
              .filter((id) => !chosen.includes(id))
              .map((id) => (
                <button key={id} className="list-item code" onClick={() => onChange([...chosen, id])}>
                  {text(id)}
                </button>
              ))}
          </div>
        </div>
      );
    }
    case "schema_completion":
      return (
        <textarea className="input" placeholder='{ "name": "…", "arguments": { … } }' value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />
      );
    case "short_answer":
      return (
        <textarea
          className="input"
          style={{ fontFamily: "var(--font)", fontSize: "var(--t-md)" }}
          placeholder="One or two sentences"
          value={(value as string) ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

const CERTAINTY: { value: Certainty; label: string }[] = [
  { value: 1, label: "Guessing" },
  { value: 2, label: "Fairly sure" },
  { value: 3, label: "Sure" },
];

/** The quiz, one question at a time. Pilot items aren't scored, so they may be skipped. */
export function QuizFlow({ quiz, busy, onSubmit }: { quiz: QuizItem[]; busy: boolean; onSubmit: (answers: Response[], certainty: Certainty[]) => void }) {
  const [index, setIndexState] = useState(0);
  // A question counts as done in the progress bar once the learner has been to it, so a default
  // answer (an ordering's starting order) doesn't look like their answer.
  const [visited, setVisited] = useState<Set<number>>(() => new Set([0]));
  const setIndex = (i: number) => {
    setIndexState(i);
    setVisited((v) => new Set(v).add(i));
  };
  const [answers, setAnswers] = useState<(Response | undefined)[]>(() => quiz.map(initialResponse));
  const [certainty, setCertainty] = useState<Certainty[]>(() => quiz.map(() => 2));
  const ready = (i: number) => quiz[i]!.pilot || isAnswered(quiz[i]!, answers[i]);
  const item = quiz[index]!;
  const last = index === quiz.length - 1;
  const allReady = quiz.every((_, i) => ready(i));

  return (
    <>
      <div className="progressbar" role="group" aria-label="Questions">
        {quiz.map((q, i) => (
          <button
            key={q.id}
            aria-current={i === index ? "step" : undefined}
            aria-label={`Go to question ${i + 1}${visited.has(i) && ready(i) ? ", answered" : ""}`}
            className={i === index ? "current" : visited.has(i) && ready(i) ? "done" : ""}
            onClick={() => setIndex(i)}
          />
        ))}
      </div>

      <div className="question" key={item.id}>
        <div className="kind">
          {index + 1} of {quiz.length} · {TYPE_LABEL[item.type]}
          {item.pilot && <span className="chip amber" style={{ marginLeft: 8 }}>pilot · not scored</span>}
        </div>
        <div className="prompt">{item.prompt}</div>
        <ItemInput item={item} value={answers[index]} onChange={(r) => setAnswers((a) => a.map((v, j) => (j === index ? r : v)))} />
        <div className="certainty">
          <span>How sure are you?</span>
          <div className="segmented">
            {CERTAINTY.map((c) => (
              <button key={c.value} className={certainty[index] === c.value ? "on" : ""} onClick={() => setCertainty((s) => s.map((v, j) => (j === index ? c.value : v)))}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="quiz-nav">
        <button className="btn quiet" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          ← Back
        </button>
        {last ? (
          <button
            className="btn primary"
            disabled={busy || !allReady}
            title={allReady ? "" : "Answer every question first"}
            onClick={() => onSubmit(answers.map((a, i) => a ?? initialResponse(quiz[i]!) ?? ""), certainty)}
          >
            {busy ? "Checking…" : "Submit answers"}
          </button>
        ) : (
          <button className="btn primary" disabled={!ready(index)} onClick={() => setIndex(index + 1)}>
            Next →
          </button>
        )}
      </div>
    </>
  );
}
