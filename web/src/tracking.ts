import { useEffect, useRef } from "react";
import type { Call } from "./types.js";

/** How often to report time on a lesson while it stays open. */
const FLUSH_MS = 60_000;

/**
 * Reports time spent on a lesson while its tab is visible: every minute, when the tab is hidden, and when
 * the learner moves to another lesson. Best effort: a report that fails is dropped, never retried in a loop.
 */
export function useLessonTimer(lessonId: string, call: Call, enabled: boolean) {
  const since = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const visible = () => document.visibilityState === "visible";
    since.current = visible() ? Date.now() : null;

    const flush = () => {
      if (since.current === null) return;
      const active_ms = Math.min(Date.now() - since.current, 10 * 60_000);
      since.current = visible() ? Date.now() : null;
      if (active_ms >= 1000) void call("track", [{ kind: "lesson", lesson: lessonId, active_ms }]).catch(() => {});
    };
    const onVisibility = () => {
      if (visible()) since.current = Date.now();
      else flush();
    };

    const timer = setInterval(flush, FLUSH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [lessonId, call, enabled]);
}

/** Reports an intervention shown or completed, once each per mount. */
export function interventionTracker(call: Call, block_id: string, context: "path" | "preview") {
  const sent = new Set<string>();
  return (event: "shown" | "completed") => {
    if (sent.has(event)) return;
    sent.add(event);
    void call("track", [{ kind: "intervention", event, block_id, context }]).catch(() => {});
  };
}
