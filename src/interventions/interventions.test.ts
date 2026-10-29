import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileCourse } from "../course/compile.js";
import { getCourse } from "../course/bundle.js";
import { checkIntervention, overlap } from "./checks.js";
import { EXEMPLARS } from "./exemplars.js";
import { referenceCurator } from "../eval/reference.js";
import { scenarioPerformance } from "../simulation/index.js";
import { getScenario } from "../simulation/scenarios.js";
import { referenceDraft } from "./reference.js";
import { allowedTemplates, type Intervention } from "./templates.js";

const course = getCourse();
const contrast = EXEMPLARS.find((e) => e.template === "contrast")!;
const ctx = { course, lessonId: "agent-loop", misconception: "model-executes-actions", existing: [] };
const withCheck = (patch: Partial<Extract<Intervention, { template: "contrast" }>["check"]>): Intervention => ({
  ...(contrast as Extract<Intervention, { template: "contrast" }>),
  check: { ...(contrast as Extract<Intervention, { template: "contrast" }>).check, ...patch },
});

describe("checkIntervention", () => {
  it("passes every hand-written exemplar", () => {
    for (const e of EXEMPLARS) {
      const lessonId = course.getMisconception(e.targets)!.lesson;
      assert.deepEqual(checkIntervention(e, { course, lessonId, misconception: e.targets, existing: [] }), [], `${e.template} ${e.targets}`);
    }
  });

  it("requires the diagnosed misconception, taught in this lesson", () => {
    assert.match(checkIntervention(contrast, { ...ctx, misconception: "loop-always-terminates" }).join(), /diagnosis is about "loop-always-terminates"/);
    assert.match(checkIntervention(contrast, { ...ctx, lessonId: "tool-calling" }).join(), /taught in "agent-loop", not "tool-calling"/);
  });

  it("rejects a question that repeats a quiz question, even reworded a little", () => {
    const leaked = withCheck({ prompt: "Who actually carries out an action that the model chooses?" });
    assert.match(checkIntervention(leaked, ctx).join(), /repeats quiz question "agent-loop-q2"/);
    assert.ok(overlap("Who actually carries out an action that the model chooses?", "Who actually carries out an action the model chooses?") >= 0.7);
  });

  it("rejects an answer that gives a quiz answer away", () => {
    const options = withCheck({}).template === "contrast" ? (contrast as Extract<Intervention, { template: "contrast" }>).check.options : [];
    const leaked = withCheck({
      options: options.map((o) => (o.correct ? { ...o, text: "The program around the model, often called the harness." } : o)),
    });
    assert.match(checkIntervention(leaked, ctx).join(), /gives away quiz question "agent-loop-q2"/);
  });

  it("requires a wrong option that expresses the belief", () => {
    const options = (contrast as Extract<Intervention, { template: "contrast" }>).check.options.map((o) => ({ ...o, misconception: null }));
    assert.match(checkIntervention(withCheck({ options }), ctx).join(), /no wrong option expresses/);
  });

  it("rejects markup and links", () => {
    assert.match(checkIntervention({ ...contrast, belief: "See <script>alert(1)</script>" } as Intervention, ctx).join(), /markup or links/);
    assert.match(checkIntervention({ ...contrast, belief: "See [docs](https://x.y)" } as Intervention, ctx).join(), /markup or links/);
  });

  it("rejects a second intervention of the same template for the same belief", () => {
    assert.match(checkIntervention(contrast, { ...ctx, existing: [contrast] }).join(), /already live/);
  });
});

describe("allowedTemplates", () => {
  it("refutes a confidently held belief and practises an unsure one", () => {
    assert.deepEqual(allowedTemplates(0.8), ["contrast", "step_through"]);
    assert.deepEqual(allowedTemplates(0.2), ["practice"]);
  });
});

describe("referenceDraft", () => {
  it("releases the exemplar, attached where the harness is taught", () => {
    const data = scenarioPerformance(getScenario("dominant-misconception"));
    const draft = referenceDraft(referenceCurator(data), data, compileCourse(course).lessons);
    assert.equal(draft.section_id, "agent-loop/the-harness-does-the-acting");
    assert.equal(draft.intervention.template, "contrast");
  });
});
