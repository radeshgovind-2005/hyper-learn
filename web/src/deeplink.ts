// Links to a place in a course: `/c/<id>#<lesson>/<section>`. A section's id is already
// `<lesson>/<slug>`, so the hash is the section id, or a lesson id alone.

/** What a hash points at in these lessons; null when it names no lesson. A section that no longer exists falls back to its lesson. */
export function parseHash(hash: string, lessons: readonly { id: string; archived?: boolean; sections: readonly { id: string; archived?: boolean }[] }[]): { lesson: string; section?: string } | null {
  let raw = hash.replace(/^#/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!raw) return null;
  const lessonId = raw.split("/")[0]!;
  const lesson = lessons.find((l) => l.id === lessonId && !l.archived);
  if (!lesson) return null;
  const section = raw.includes("/") ? lesson.sections.find((s) => s.id === raw && !s.archived) : undefined;
  return section ? { lesson: lesson.id, section: section.id } : { lesson: lesson.id };
}

/** The hash for a lesson, or a section of it. */
export const hashOf = (lesson: string, section?: string) => `#${section ?? lesson}`;
