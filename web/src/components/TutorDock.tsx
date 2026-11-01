import { useCallback, useEffect, useRef, useState } from "react";
import { useVoice } from "../hooks/useVoice.js";
import type { Call, StreamCall, TutorAction, TutorAsk, TutorEvent, TutorInfo, TutorTurnResult } from "../types.js";
import "../styles/tutor.css";

// "Ask Muse": a bar at the bottom of the lesson. The learner types or says what they're stuck on; the
// reply streams into a panel above the bar with the steps Muse takes, and the page changes for them
// (it scrolls to a section, opens a source page, or grows a "Made for you" block under a section).

interface Message {
  role: "user" | "assistant";
  text: string;
}

const SHORTCUTS = [
  { shortcut: "explain", label: "Explain differently", text: "Explain this section differently." },
  { shortcut: "example", label: "Give me an example", text: "Give me a worked example for this section." },
  { shortcut: "quiz", label: "Quiz me on this", text: "Quiz me on this section." },
] as const;

/** The section the learner is reading: the last one whose top has passed a third of the way down the screen. */
function sectionInView(): string | undefined {
  const sections = [...document.querySelectorAll<HTMLElement>(".lesson .section[id]")];
  const line = window.innerHeight * 0.35;
  let current: string | undefined;
  for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s.id;
  return current ?? sections[0]?.id;
}

export function TutorDock({
  call,
  stream,
  courseId,
  lessonId,
  token,
  onAction,
  onBlocks,
}: {
  call: Call;
  stream: StreamCall;
  courseId: string;
  lessonId: string;
  token: () => Promise<string>;
  onAction: (action: TutorAction) => void;
  /** Personal blocks were started or changed: the page should fetch them. */
  onBlocks: () => void;
}) {
  const [info, setInfo] = useState<TutorInfo | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [streaming, setStreaming] = useState("");
  const [ask, setAsk] = useState<TutorAsk | null>(null);
  const [answered, setAnswered] = useState<{ option: number; correct: boolean; feedback?: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);

  const voice = useVoice({ courseId, token, onText: (text) => setDraft(text) });

  // The conversation is per lesson: switching lessons loads that lesson's.
  useEffect(() => {
    setMessages([]);
    setAsk(null);
    setAnswered(null);
    setError(null);
    void call<TutorInfo>("tutorInfo", [lessonId])
      .then((i) => {
        setInfo(i);
        setMessages(i.history.filter((m) => m.role !== "summary").map((m) => ({ role: m.role as Message["role"], text: m.text })));
      })
      .catch(() => setInfo(null));
  }, [call, lessonId]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [messages, streaming, steps, ask, open]);

  const send = useCallback(
    (text: string, shortcut?: (typeof SHORTCUTS)[number]["shortcut"]) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const section = sectionInView();
      setMessages((m) => [...m, { role: "user", text: trimmed }]);
      setDraft("");
      setBusy(true);
      setSteps([]);
      setStreaming("");
      setError(null);
      setOpen(true);
      setMenu(false);
      setAsk(null);
      setAnswered(null);
      stream("tutorTurn", [{ lesson: lessonId, ...(section && { section }), text: trimmed, ...(shortcut && { shortcut }) }], {
        onChunk: (chunk) => {
          const event = chunk as TutorEvent;
          if (event.type === "step") {
            setSteps((s) => (s.at(-1) === event.label ? s : [...s, event.label]));
            setStreaming("");
          } else setStreaming((t) => t + event.delta);
        },
        onDone: (final) => {
          const result = (final as { result: TutorTurnResult }).result;
          setMessages((m) => [...m, { role: "assistant", text: result.reply }]);
          setStreaming("");
          setSteps([]);
          setBusy(false);
          if (result.ask) setAsk(result.ask);
          for (const action of result.actions) onAction(action);
          if (result.blocks.length > 0) onBlocks();
          setInfo((i) => (i ? { ...i, turns_left: Math.max(0, i.turns_left - 1) } : i));
        },
        onError: (message) => {
          setError(message);
          setBusy(false);
          setSteps([]);
          setStreaming("");
        },
      });
    },
    [busy, lessonId, stream, onAction, onBlocks],
  );

  const answer = async (option: number) => {
    if (!ask || answered) return;
    try {
      const result = await call<{ correct: boolean; feedback?: string }>("answerAsk", [ask.id, option]);
      setAnswered({ option, ...result });
      send(`I answered: "${ask.options[option]}"`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!info?.available) return null;
  const listening = voice.state === "listening" || voice.state === "connecting";

  return (
    <div className={`tutor-dock ${open ? "open" : ""}`} onKeyDown={(e) => e.key === "Escape" && (setOpen(false), setMenu(false))}>
      {open && (
        <section className="tutor-panel" aria-label="Muse">
          <div className="tutor-panel-head">
            <strong>Ask Muse</strong>
            <span className="small muted">{info.turns_left} questions left today</span>
            <span className="grow" />
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close Muse">
              ✕
            </button>
          </div>
          <div className="tutor-log" ref={log} role="log" aria-live="polite">
            {messages.length === 0 && !busy && <p className="small muted">Tell me what you're stuck on in this lesson. I'll find what's missing and change this page for you.</p>}
            {messages.map((m, i) => (
              <div key={i} className={`tutor-msg ${m.role}`}>
                {m.text}
              </div>
            ))}
            {busy && (
              <div className="tutor-msg assistant thinking">
                {streaming && <div>{streaming}</div>}
                <div className="tutor-steps">
                  <span className="spinner" /> Muse is thinking
                  {steps.length > 0 && <span className="muted"> · {steps.at(-1)}…</span>}
                </div>
                {steps.length > 1 && (
                  <ol className="tutor-step-list small muted">
                    {steps.slice(0, -1).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                )}
              </div>
            )}
            {ask && (
              <div className="tutor-ask">
                <div className="check-label small">A quick question first</div>
                <div className="prompt">{ask.prompt}</div>
                <div className="options" role="radiogroup">
                  {ask.options.map((text, i) => (
                    <button key={i} className={`option ${answered?.option === i ? "picked" : ""}`} role="radio" aria-checked={answered?.option === i} disabled={answered !== null} onClick={() => void answer(i)}>
                      <span className="mark" aria-hidden />
                      <span>{text}</span>
                    </button>
                  ))}
                </div>
                {answered?.feedback && <div className={`check-feedback ${answered.correct ? "right" : "wrong"}`}>{answered.feedback}</div>}
              </div>
            )}
            {error && <div className="notice">{error}</div>}
          </div>
        </section>
      )}
      <form
        className="tutor-bar"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="tutor-menu-wrap">
          <button type="button" className="icon-btn tutor-plus" aria-label="Shortcuts" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            +
          </button>
          {menu && (
            <div className="tutor-menu" role="menu">
              {SHORTCUTS.map((s) => (
                <button key={s.shortcut} type="button" role="menuitem" onClick={() => send(s.text, s.shortcut)} disabled={busy}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={input}
          className="tutor-input"
          rows={1}
          value={draft}
          maxLength={1000}
          placeholder={listening ? (voice.state === "connecting" ? "Connecting…" : "Listening… press the mic again when you're done") : "Ask Muse what you're stuck on…"}
          aria-label="Ask Muse"
          onFocus={() => messages.length > 0 && setOpen(true)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        <button
          type="button"
          className={`icon-btn tutor-mic ${listening ? "on" : ""}`}
          aria-label={listening ? "Stop recording" : "Speak"}
          aria-pressed={listening}
          title={voice.engine === "browser" ? "Voice (browser speech)" : "Voice (Muse Voice Transcribe)"}
          onClick={() => (listening ? voice.stop() : void voice.start())}
          disabled={voice.state === "finishing"}
        >
          {voice.state === "finishing" ? <span className="spinner" /> : "🎙"}
        </button>
        <button type="submit" className="btn primary sm" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
      {(voice.error || voice.engine === "browser") && (
        <div className="tutor-voice-note small muted">
          {voice.engine === "browser" ? "Voice: browser speech recognition. " : ""}
          {voice.error}
        </div>
      )}
    </div>
  );
}
