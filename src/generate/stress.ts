import { computePerformance } from "../analytics/performance.js";
import { wrongOptions } from "../assessment/answers.js";
import { type CourseSnapshot, courseFromSnapshot } from "../course/compile.js";
import { ancestorsOf } from "../course/graph.js";
import type { Course } from "../course/schema.js";
import { referenceCurator } from "../eval/reference.js";
import { DEFAULT_LEARNER_MODEL, simulate } from "../simulation/learners.js";
import type { Scenario } from "../simulation/scenarios.js";
import type { Mutation } from "../state.js";

// Step 8: can this course's questions catch a broken prerequisite? Simulated learners take the built
// course with one real prerequisite edge left out of the published graph (the "missing-prereq"
// scenario, on this course), and the rule-based Curator reads the result. Code only, no model. A miss
// is a warning: the course still works, but the repair loop would be blind to that kind of fault.

export interface StressResult {
  /** detected / missed, or skipped when the course has no edge to remove. */
  outcome: "detected" | "missed" | "skipped";
  detail: string;
  edge?: readonly [lesson: string, prerequisite: string];
  proposal?: Mutation;
}

/** Items of `lessonId` with a wrong answer that reveals a gap in `prereq`. */
const revealing = (course: Course, lessonId: string, prereq: string) =>
  course.getLesson(lessonId)!.quiz.filter((item) => wrongOptions(item, lessonId).some((o) => o.reveals.points_to === prereq)).length;

/**
 * The edge to remove: one whose removal really frees learners (the prerequisite isn't also reached
 * through another prerequisite) and whose lesson has the most questions that can reveal the gap.
 */
export function stressEdge(course: Course): readonly [string, string] | undefined {
  let best: { edge: readonly [string, string]; score: number } | undefined;
  for (const lesson of course.lessons) {
    for (const prereq of lesson.prerequisites) {
      const implied = lesson.prerequisites.some((other) => other !== prereq && ancestorsOf(course.graph, other).has(prereq));
      if (implied) continue;
      const score = revealing(course, lesson.id, prereq) / Math.max(1, lesson.quiz.length);
      if (!best || score > best.score) best = { edge: [lesson.id, prereq], score };
    }
  }
  return best?.edge;
}

export function stressTest(snapshot: CourseSnapshot, { seed = 808, learners = DEFAULT_LEARNER_MODEL.learners }: { seed?: number; learners?: number } = {}): StressResult {
  const course = courseFromSnapshot(snapshot);
  const edge = stressEdge(course);
  if (!edge) return { outcome: "skipped", detail: "The course has no prerequisite edge whose removal would change what learners can take first." };

  const [lesson, prereq] = edge;
  const scenario: Scenario = {
    id: "stress-missing-prereq",
    title: `Missing prerequisite — ${prereq} → ${lesson}`,
    description: `The published graph lets learners start ${lesson} before ${prereq}.`,
    seed,
    removeEdges: [edge],
    expected: { action: "add_prerequisite", node_id: lesson, target_node_id: prereq, misconception_id: null },
  };
  const { published, attempts } = simulate(course, scenario, { model: { ...DEFAULT_LEARNER_MODEL, learners } });
  const proposal = referenceCurator(computePerformance(course, published, attempts));
  const detected = proposal.action === "add_prerequisite" && proposal.node_id === lesson && proposal.target_node_id === prereq;
  const coverage = `${revealing(course, lesson, prereq)} of ${course.getLesson(lesson)!.quiz.length} questions in ${lesson} can reveal the gap`;
  return {
    outcome: detected ? "detected" : "missed",
    edge,
    proposal,
    detail: detected
      ? `With ${prereq} → ${lesson} removed, simulated learners' answers led the reference Curator to restore it (${coverage}).`
      : `With ${prereq} → ${lesson} removed, the reference Curator proposed ${proposal.action} on ${proposal.node_id} instead (${coverage}): ${proposal.reason}`,
  };
}
