import type { BaseMessage } from "@langchain/core/messages";
import type { Invokable } from "../models.js";
import type { BuilderModels } from "./models.js";
import type { AssessmentDraft, GroundingVerdict, ItemDraft, OptionDraft, PlanDraft, SectionDraft } from "./schemas.js";

// Stand-in generation models with no model behind them: each reads the prompt the pipeline built and
// answers with a mechanical but valid draft (sentences lifted from the pages, templated questions).
// For `npm run generate -- --dry-run` and tests, to exercise the whole pipeline and its checks
// offline. The content is not a course anyone should learn from.

const userText = (messages: BaseMessage[]) => {
  const last = messages.at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};

/** An Invokable that answers from the user message. */
export const responder = <T>(answer: (prompt: string) => T): Invokable<T> => ({
  invoke: async (messages) => answer(userText(messages)),
});

const sentences = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const words = (text: string, n: number) => text.split(/\s+/).slice(0, n).join(" ").replace(/[.,;:!?]+$/, "");
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function cannedDigest(prompt: string) {
  const assessment = !prompt.includes("This is teaching material");
  const points = [...prompt.matchAll(/<page n="(\d+)">\n([\s\S]*?)\n<\/page>/g)].flatMap(([, page, text]) => {
    const first = sentences(text!).slice(0, 2);
    if (first.length === 0) return [];
    return [{ text: assessment ? `Asks learners to explain and apply: ${words(first[0]!, 6)}.` : first.join(" "), pages: [Number(page)] }];
  });
  return { points };
}

export function cannedPlan(prompt: string): PlanDraft {
  const lessonCount = Number(/Plan (\d+) to \d+ lessons/.exec(prompt)?.[1] ?? 3);
  const refs: { source: string; page: number; idea: string }[] = [];
  for (const [, source, pages, idea] of prompt.matchAll(/^- \[(\S+) p\.([\d,]+)\] (.+)$/gm)) {
    const page = Number(pages!.split(",")[0]);
    if (!refs.some((r) => r.source === source && r.page === page)) refs.push({ source: source!, page, idea: idea! });
  }
  if (refs.length === 0) return { lessons: [] };
  return {
    lessons: Array.from({ length: lessonCount }, (_, i) => {
      const sections = [0, 1].map((j) => refs[(i * 2 + j) % refs.length]!);
      return {
        title: `Part ${i + 1}: ${words(sections[0]!.idea, 4)}`,
        summary: cut(sections[0]!.idea, 200),
        prerequisites: i > 0 ? [i] : [],
        sections: sections.map((ref, j) => ({ title: `${words(ref.idea, 5)} (${j + 1})`, pages: [{ source: ref.source, page: ref.page }] })),
        objectives: sections.map((ref, j) => ({ statement: `Explain ${words(ref.idea, 8).toLowerCase()}`, sections: [j + 1] })),
      };
    }),
  };
}

export function cannedSection(prompt: string): SectionDraft {
  const title = /Write the section "(.+)"\./.exec(prompt)?.[1] ?? "this section";
  const pages = [...prompt.matchAll(/<source id="([^"]+)" page="(\d+)">\n([\s\S]*?)\n<\/source>/g)];
  const blocks = pages.flatMap(([, source, page, text]) => {
    const first = sentences(text!).slice(0, 2).join(" ");
    return first ? [{ markdown: first, cites: [{ source: source!, page: Number(page) }] }] : [];
  });
  const claim = cut(sentences(pages[0]?.[3] ?? "").at(0) ?? `The section explains ${title}.`, 190);
  return {
    blocks,
    check: {
      prompt: cut(`Which statement agrees with the section "${title}"?`, 290),
      options: [
        { text: claim, correct: true, feedback: "Right: this is what the section explains." },
        { text: "The section says the opposite of this.", correct: false, feedback: "Not quite: reread the first paragraph." },
        { text: "The section does not discuss this topic.", correct: false, feedback: "It does: the first paragraph is about it." },
      ],
    },
  };
}

const ITEM_TYPES = ["single_choice", "multi_select", "two_tier", "ordering"] as const;

export function cannedAssessment(prompt: string): AssessmentDraft {
  const lesson = /Lesson "([^"]+)"/.exec(prompt)?.[1] ?? "the lesson";
  // One objective per call: the one the prompt names.
  const target = Number(/Write \d+ questions for objective O(\d+)/.exec(prompt)?.[1] ?? 0);
  const objectives = [...prompt.matchAll(/^O(\d+): (.+)$/gm)]
    .map(([, n, statement]) => ({ n: Number(n), statement: statement! }))
    .filter(({ n }) => !target || n === target);
  const perObjective = Number(/Write (\d+) questions for objective/.exec(prompt)?.[1] ?? 3);
  const block = /Prerequisites \(gap ids[^\n]*\n((?:- [^\n]*\n?)+)/.exec(prompt)?.[1] ?? "";
  const prereqs = [...block.matchAll(/^- ([a-z0-9]+(?:-[a-z0-9]+)*): /gm)].map((m) => m[1]!);
  const misconceptions = [1, 2].map((k) => ({ name: `${words(lesson, 3)} mix-up ${k}`, belief: `Belief ${k}: ${lesson} works the other way round.` }));

  const wrong = (text: string, gap: string | null, misconception: number | null): OptionDraft => ({ text, correct: false, gap, misconception });
  const right = (text: string): OptionDraft => ({ text, correct: true, gap: null, misconception: null });
  let count = 0;
  const items: ItemDraft[] = objectives.flatMap(({ n, statement }) =>
    Array.from({ length: perObjective }, (_, v): ItemDraft => {
      const type = ITEM_TYPES[count++ % ITEM_TYPES.length]!;
      const misconception = ((v + n) % misconceptions.length) + 1;
      const tagged = [...prereqs.map((p) => wrong(`An answer that skips ${p}`, p, null)), wrong(`An answer that believes mix-up ${misconception}`, null, misconception)];
      const base = { objective: n, type, prompt: `Version ${v + 1}: which answer fits "${statement}"?`, reason_prompt: null, reasons: [], steps: [], wrong_orders: [] };
      switch (type) {
        case "single_choice":
          return { ...base, options: [right("The answer the lesson gives"), ...tagged, wrong("An unrelated answer", null, null)] };
        case "multi_select":
          return { ...base, options: [right("One part of the lesson's answer"), right("Another part of it"), ...tagged] };
        case "two_tier":
          return {
            ...base,
            options: [right("The answer the lesson gives"), ...tagged],
            reason_prompt: "Why?",
            reasons: [right("Because the lesson shows it"), wrong(`Because of mix-up ${misconception}`, null, misconception), wrong("No particular reason", null, null)],
          };
        case "ordering": {
          const steps = Array.from({ length: prereqs.length + 3 }, (_, k) => `Step ${k + 1} of ${words(statement, 4)}`);
          return {
            ...base,
            options: [],
            steps,
            wrong_orders: [
              ...prereqs.map((p, k) => ({ later: k + 2, earlier: k + 1, gap: p, misconception: null })),
              { later: prereqs.length + 2, earlier: prereqs.length + 1, gap: null, misconception },
            ],
          };
        }
      }
    }),
  );
  return { misconceptions, items };
}

/** Canned models for every generation agent. */
export function cannedBuilderModels(): BuilderModels {
  return {
    classifier: responder((prompt) => ({
      role: /question \d|answer all|\(\d+ marks\)/i.test(prompt) ? ("assessment" as const) : ("material" as const),
      reason: "canned",
    })),
    digester: responder(cannedDigest),
    planner: responder(cannedPlan),
    writer: responder(cannedSection),
    examiner: responder(cannedAssessment),
    fact_checker: responder((): GroundingVerdict => ({ supported: true, unsupported: [] })),
  };
}
