import { useEffect, useState } from "react";

// A quiet map of the page in its left margin: one tick per section, darker and longer for the sections
// on screen. Hovering (or focusing) a tick previews that section; clicking scrolls to it. It only reads
// the page (sections are found by id), so any long page can use it.

export interface RailItem {
  id: string;
  title: string;
  /** A sentence or two of the section's text, shown in the preview. */
  preview: string;
}

/** Markdown to a short plain-text preview. */
export function plainPreview(markdown: string, max = 220): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function SectionRail({ items }: { items: RailItem[] }) {
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);

  // Which sections are on screen: every one that intersects the viewport, as the reader scrolls.
  const ids = items.map((i) => i.id).join("\u0000");
  useEffect(() => {
    const elements = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => e !== null);
    if (elements.length === 0) return;
    const onScreen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) onScreen.add(e.target.id);
          else onScreen.delete(e.target.id);
        }
        setVisible(new Set(onScreen));
      },
      { rootMargin: "-10% 0px -20% 0px" },
    );
    elements.forEach((e) => observer.observe(e));
    return () => observer.disconnect();
    // Re-observed only when the set of sections changes, not on every render.
  }, [ids]);

  if (items.length < 3) return null;
  const go = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setOpen(null);
  };

  return (
    <nav className="rail" aria-label="Sections of this page" onMouseLeave={() => setOpen(null)}>
      <ol className="rail-ticks">
        {items.map((item) => (
          <li key={item.id} className="rail-item">
            <button
              className={`rail-tick ${visible.has(item.id) ? "on" : ""}`}
              aria-label={item.title}
              aria-current={visible.has(item.id) ? "location" : undefined}
              onMouseEnter={() => setOpen(item.id)}
              onFocus={() => setOpen(item.id)}
              onBlur={() => setOpen(null)}
              onClick={() => go(item.id)}
            >
              <span aria-hidden />
            </button>
            {open === item.id && (
              <div className="rail-card" role="tooltip">
                <div className="rail-card-title">{item.title}</div>
                {item.preview && <div className="rail-card-preview">{item.preview}</div>}
              </div>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
