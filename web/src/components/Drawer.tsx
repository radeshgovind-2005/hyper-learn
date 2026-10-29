import { type ReactNode, useEffect, useRef } from "react";

/** A side drawer: docked beside the content on wide screens, over it (with a scrim) on narrow ones. */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`scrim ${open ? "open" : ""}`} onClick={onClose} aria-hidden />
      <aside className={`drawer ${open ? "open" : ""}`} aria-label={title} aria-hidden={!open} inert={!open}>
        <div className="drawer-inner">
          <div className="drawer-head">
            <h2>{title}</h2>
            <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label={`Close ${title}`}>
              ✕
            </button>
          </div>
          <div className="drawer-body">{children}</div>
        </div>
      </aside>
    </>
  );
}
