import { useCallback, useEffect, useRef, useState } from "react";
import type { StoryFrame } from "../types.js";

// A narrated storyboard: frames with a caption and a picture, narrated by the browser's speech
// synthesis (Meta has no text-to-speech). With sound off, each frame stays up long enough to read.

const SILENT_FRAME_MS = 6_000;

export function Storyboard({ title, frames, image }: { title: string; frames: readonly StoryFrame[]; image: (id: string) => React.ReactNode }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState(() => typeof window !== "undefined" && "speechSynthesis" in window);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = frames[index]!;

  const stopAll = useCallback(() => {
    clearTimeout(timer.current);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  useEffect(() => {
    if (!playing) return stopAll();
    const next = () => {
      if (index + 1 < frames.length) setIndex(index + 1);
      else setPlaying(false);
    };
    if (sound && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(frame.narration);
      utterance.onend = next;
      window.speechSynthesis.speak(utterance);
    } else {
      timer.current = setTimeout(next, SILENT_FRAME_MS);
    }
    return stopAll;
  }, [playing, index, sound, frame.narration, frames.length, stopAll]);

  return (
    <div className="storyboard" aria-label={`Storyboard: ${title}`}>
      <div className="storyboard-head">
        <strong>{title}</strong>
        <span className="small muted">
          {index + 1} / {frames.length}
        </span>
      </div>
      <div className="storyboard-frame">
        {frame.image ? image(frame.image) : <div className="storyboard-card">{frame.caption}</div>}
        <div className="storyboard-caption">{frame.caption}</div>
        {(!sound || !playing) && <p className="storyboard-narration small">{frame.narration}</p>}
      </div>
      <div className="row storyboard-controls">
        <button className="btn secondary sm" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} aria-label="Previous frame">
          ←
        </button>
        <button className="btn primary sm" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : index + 1 === frames.length && !playing && index > 0 ? "Play again" : "Play"}
        </button>
        <button className="btn secondary sm" onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))} disabled={index + 1 === frames.length} aria-label="Next frame">
          →
        </button>
        <label className="small muted storyboard-sound">
          <input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} disabled={!("speechSynthesis" in window)} /> Narration
        </label>
      </div>
    </div>
  );
}
