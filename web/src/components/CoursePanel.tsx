import type { CourseSnapshot, LessonProgress } from "../types.js";

function stateOf(progress: LessonProgress | undefined): { className: string; label: string } {
  if (!progress) return { className: "", label: "Not started" };
  if (progress.mastered) return { className: "mastered", label: "Mastered" };
  if (!progress.passed && progress.beliefs.length > 0) return { className: "rerouted", label: "Showed a misconception: help was added to your path" };
  return { className: "progress", label: `In progress · mastery ${Math.round(progress.mastery * 100)}%` };
}

export function CoursePanel({
  snapshot,
  lessonId,
  onSelectLesson,
  progress,
}: {
  snapshot: CourseSnapshot | null;
  lessonId: string;
  onSelectLesson: (id: string) => void;
  progress: LessonProgress[];
}) {
  const lessons = snapshot?.lessons.filter((l) => !l.archived) ?? [];
  const mastered = progress.filter((p) => p.mastered).length;

  return (
    <>
      <div className="course-card">
        <div className="eyebrow">Course</div>
        <div className="title">{snapshot?.title ?? "…"}</div>
        <div className="small muted">
          {mastered} of {lessons.length || 6} lessons mastered
        </div>
        <div className="meter" aria-hidden>
          <span style={{ width: `${lessons.length ? (mastered / lessons.length) * 100 : 0}%` }} />
        </div>
      </div>

      <ol className="path">
        {lessons.map((lesson, i) => {
          const state = stateOf(progress.find((p) => p.lesson === lesson.id));
          const on = lesson.id === lessonId;
          return (
            <li key={lesson.id}>
              <button className={`path-item ${on ? "on" : ""}`} onClick={() => onSelectLesson(lesson.id)} aria-current={on ? "page" : undefined} title={state.label}>
                <span className={`num ${state.className}`}>{state.className === "mastered" ? "✓" : i + 1}</span>
                <span className="grow">{lesson.title}</span>
              </button>
              {on && (
                <ul className="sections">
                  {lesson.sections
                    .filter((s) => !s.archived && s.title)
                    .map((s) => (
                      <li key={s.id}>
                        <a href={`#${s.id}`}>{s.title}</a>
                      </li>
                    ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
