import { useState } from "react";
import { useNavigate } from "react-router";
import { coursePath } from "../directory.js";
import type { CourseCard, MyCourses } from "../types.js";

const STATUS_LABEL = { draft: "Draft", building: "Building", review: "Ready to publish", published: "" } as const;

function Group({ title, courses, current, onOpen }: { title: string; courses: CourseCard[]; current: string | null; onOpen: (id: string) => void }) {
  if (courses.length === 0) return null;
  return (
    <div className="switcher-group">
      <div className="eyebrow">{title}</div>
      {courses.map((c) => (
        <button key={c.id} className={`switcher-item ${c.id === current ? "on" : ""}`} onClick={() => onOpen(c.id)} aria-current={c.id === current ? "page" : undefined}>
          <span className="grow">{c.title}</span>
          {STATUS_LABEL[c.status] && <span className="chip">{STATUS_LABEL[c.status]}</span>}
        </button>
      ))}
    </div>
  );
}

/** The course list at the top of the sidebar: mine, shared with me, featured, and "New course". */
export function CourseSwitcher({ courses, current, currentTitle }: { courses: MyCourses | null; current: string | null; currentTitle?: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };
  return (
    <div className="switcher">
      <button className="switcher-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="grow">{currentTitle ?? "Your courses"}</span>
        <span aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="switcher-panel">
          {courses ? (
            <>
              <Group title="My courses" courses={courses.owned} current={current} onOpen={(id) => go(coursePath(id))} />
              <Group title="Shared with me" courses={courses.shared} current={current} onOpen={(id) => go(coursePath(id))} />
              <Group title="Featured" courses={courses.featured} current={current} onOpen={(id) => go(coursePath(id))} />
            </>
          ) : (
            <div className="small muted">Loading…</div>
          )}
          <button className="btn secondary sm" onClick={() => go("/new")}>
            + New course
          </button>
        </div>
      )}
    </div>
  );
}
