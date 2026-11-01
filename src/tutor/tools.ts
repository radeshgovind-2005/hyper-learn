import { z } from "zod";
import { type CourseSnapshot, isTextBlock, type LessonNode, type Section } from "../course/compile.js";
import type { PageImage, PageImages, TutorAction } from "../media/contracts.js";
import type { CheckQuestion, Intervention } from "../interventions/templates.js";
import type { PersonalBlockRef, ToolSpec, TutorAsk } from "./types.js";

// The tutor's tools. The model only chooses among them; each checks its arguments in code (ids must exist
// on the learner's release, pages on the files it cites) and none returns an answer key: practice
// questions are shown without which option is right or the feedback that would say so.

/** What a tool may touch, provided by the service for one learner and one turn. Anything that throws is refused. */
export interface TutorWorld {
  /** The release the learner is served. */
  snapshot: CourseSnapshot;
  lesson: string;
  /** The files the learner may open (citedSources). */
  cited: readonly { id: string; name: string; pages: number }[];
  readPage(source: string, page: number): string;
  pageImages: PageImages;
  ask(section: string | undefined): TutorAsk;
  rewrite(section: string, note: string): PersonalBlockRef;
  draw(section: string, description: string): PersonalBlockRef;
  interact(section: string, spec: unknown): PersonalBlockRef;
  storyboard(section: string): PersonalBlockRef;
  suggest(section: string, why: string): void;
}

/** What one tool call did: text for the model, and maybe a picture, an action for the page, a block or a question. */
export interface ToolResult {
  content: string;
  image?: PageImage;
  action?: TutorAction;
  block?: PersonalBlockRef;
  ask?: TutorAsk;
  /** What the dock shows while it runs ("Reading the section"). */
  label: string;
}

/** The text a tool may return for one page: enough to explain from, bounded. */
const MAX_PAGE_CHARS = 8_000;

const id = z.string().min(1).max(200);
const page = z.number().int().min(1).max(100_000);

const ARGS = {
  read_section: z.object({ section: id.describe("A section id from the lesson outline") }),
  read_page: z.object({ source: id.describe("A source id the learner may open"), page }),
  look_at_page: z.object({ source: id, page }),
  go_to: z.object({ lesson: id, section: id }),
  open_source: z.object({ source: id, page }),
  ask_me: z.object({ section: id.optional().describe("The section the question should be about, if any") }),
  rewrite_for_me: z.object({
    section: id,
    note: z.string().max(500).describe("What the learner said is confusing, in their words; empty if they gave none"),
  }),
  draw_it: z.object({
    section: id,
    description: z.string().min(3).max(300).describe("What the diagram should show, in plain words: the parts and their labels"),
  }),
  interact: z.object({
    section: id,
    spec: z
      .string()
      .max(6_000)
      .describe(
        'One widget as JSON. Either {"template":"contrast","targets":"<misconception-slug>","belief":"…","why_it_seems_right":"…","what_actually_happens":"…","check":{"prompt":"…","options":[{"text":"…","correct":true|false,"misconception":null,"feedback":"…"}]}}, or {"template":"practice","targets":"<slug>","questions":[2–3 check objects]}, or {"template":"step_through","targets":"<slug>","title":"…","frames":[3–8 of {"caption":"…","messages":[{"role":"user|model|harness|tool","text":"…"}],"highlight":null}]}, or {"template":"explorer","targets":"<slug>","title":"…","formula":"1 / ((1 - p) + p / N)","result_label":"…","parameters":[1–4 of {"name":"N","label":"…","min":1,"max":64,"step":1,"value":8}],"plot":"N","takeaway":"…"} (a formula to play with: + - * / ^ ( ) min max log sqrt exp abs), or {"template":"compare","targets":"<slug>","title":"…","cases":[2 of {"label":"…","points":[1–5 strings],"figure":{"label":"…","value":100,"unit":"ns"} or null}],"takeaway":"…"}',
      ),
  }),
  storyboard: z.object({ section: id }),
  suggest_for_everyone: z.object({ section: id, why: z.string().min(3).max(500) }),
} as const;

export type ToolName = keyof typeof ARGS;

const DESCRIPTIONS: Record<ToolName, string> = {
  read_section: "Read one section of the learner's lesson (its text and practice questions, without answers).",
  read_page: "Read the text of one page of a source file the lesson cites.",
  look_at_page: "Look at one page of a source file as a picture (figures, tables, slides). Falls back to its text.",
  go_to: "Scroll the learner's page to a section and highlight it.",
  open_source: "Open a source file at a page beside the lesson, for the learner to read.",
  ask_me: "Ask the learner one short diagnostic question in the page, to find what they are missing. Use it BEFORE explaining something they got wrong; then wait for their answer.",
  rewrite_for_me:
    "Write a personal version of a section for this learner only (grounded in the section's pages and fact-checked; it appears under the section in about a minute). Only after a diagnostic question or a quiz showed what they are missing.",
  draw_it: "Generate a labelled diagram for a section, shown under it for this learner only.",
  interact: "Add one interactive widget under a section for this learner only: a contrast card, a practice set, a step-through, an explorer (sliders over a formula) or a compare (two cases side by side).",
  storyboard: "Make a short narrated storyboard (4–6 frames) explaining a section, for this learner only.",
  suggest_for_everyone: "Tell the course's editors that a section should change for everyone, and why.",
};

export const TOOL_SPECS: readonly ToolSpec[] = (Object.keys(ARGS) as ToolName[]).map((name) => ({ name, description: DESCRIPTIONS[name], schema: ARGS[name] }));
export const TOOL_NAMES = Object.keys(ARGS) as ToolName[];

/** A refusal the model can read and act on. */
export class Refused extends Error {}

/** A practice question as the model may see it: the prompt and the options, not which is right. */
function questionText(q: CheckQuestion): string {
  return `${q.prompt}\n${q.options.map((o, i) => `  ${String.fromCharCode(97 + i)}) ${o.text}`).join("\n")}`;
}

function interventionText(i: Intervention): string {
  switch (i.template) {
    case "contrast":
      return `[Contrast card on the mix-up "${i.belief}"] Why it seems right: ${i.why_it_seems_right} What actually happens: ${i.what_actually_happens}\nQuestion: ${questionText(i.check)}`;
    case "practice":
      return `[Practice set]\n${i.questions.map(questionText).join("\n")}`;
    case "step_through":
      return `[Step-through "${i.title}"] ${i.frames.map((f, n) => `${n + 1}. ${f.caption}`).join(" ")}`;
    case "explorer":
      return `[Explorer "${i.title}"] ${i.result_label} = ${i.formula}; sliders: ${i.parameters.map((p) => `${p.name} (${p.label}) ${p.min}..${p.max}`).join(", ")}. ${i.takeaway}`;
    case "compare":
      return `[Compare "${i.title}"] ${i.cases.map((c) => `${c.label}: ${c.points.join("; ")}`).join(" | ")}. ${i.takeaway}`;
  }
}

/** A section as the model reads it: text with the pages each block cites, and practice questions without answers. */
export function sectionText(section: Section): string {
  const parts = section.blocks
    .filter((b) => !b.archived)
    .map((b) => {
      if (isTextBlock(b)) return `${b.markdown}${b.cites?.length ? `\n(cites ${b.cites.map((c) => `${c.source} p.${c.page}`).join(", ")})` : ""}`;
      if (b.kind === "check") return `Practice question: ${questionText(b.check)}`;
      return interventionText(b.intervention);
    });
  return `## ${section.title || "Introduction"} [${section.id}]\n${parts.join("\n\n")}`;
}

export function liveLesson(snapshot: CourseSnapshot, lessonId: string): LessonNode | undefined {
  return snapshot.lessons.find((l) => l.id === lessonId && !l.archived);
}

export function liveSection(snapshot: CourseSnapshot, sectionId: string): { lesson: LessonNode; section: Section } | undefined {
  for (const lesson of snapshot.lessons) {
    if (lesson.archived) continue;
    const section = lesson.sections.find((s) => s.id === sectionId && !s.archived);
    if (section) return { lesson, section };
  }
  return undefined;
}

function needSection(world: TutorWorld, sectionId: string): { lesson: LessonNode; section: Section } {
  const found = liveSection(world.snapshot, sectionId);
  if (!found) throw new Refused(`There is no section "${sectionId}" in this course; use an id from the lesson outline`);
  return found;
}

function needSource(world: TutorWorld, source: string, pageNo: number) {
  const file = world.cited.find((s) => s.id === source);
  if (!file) throw new Refused(`"${source}" isn't a file the learner may open; these are: ${world.cited.map((s) => s.id).join(", ") || "none"}`);
  if (pageNo > file.pages) throw new Refused(`"${file.name}" has pages 1 to ${file.pages}`);
  return file;
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Runs one tool call. Bad arguments, unknown ids and refusals come back as text the model can act on; nothing throws. */
export async function runTool(world: TutorWorld, name: string, rawArgs: unknown): Promise<ToolResult> {
  if (!(name in ARGS)) {
    return { content: `Error: there is no tool "${name}". The tools are: ${TOOL_NAMES.join(", ")}.`, label: "Choosing a tool" };
  }
  const tool = name as ToolName;
  const parsed = ARGS[tool].safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"} ${i.message}`).join("; ");
    console.warn(`tutor tool ${tool} bad arguments: ${problems.slice(0, 300)}`);
    return { content: `Error: bad arguments for ${tool}: ${problems}`, label: "Choosing a tool" };
  }
  const args = parsed.data as Record<string, unknown>;
  try {
    switch (tool) {
      case "read_section": {
        const { section } = needSection(world, args.section as string);
        return { content: sectionText(section), label: `Reading "${section.title || "the introduction"}"` };
      }
      case "read_page": {
        const file = needSource(world, args.source as string, args.page as number);
        return { content: `${file.name}, page ${args.page}:\n${short(world.readPage(file.id, args.page as number), MAX_PAGE_CHARS)}`, label: `Reading page ${args.page}` };
      }
      case "look_at_page": {
        const file = needSource(world, args.source as string, args.page as number);
        const label = `Looking at page ${args.page}`;
        const image = await world.pageImages.get(file.id, args.page as number);
        if (image) return { content: `Here is page ${args.page} of ${file.name} as a picture (next message).`, image, label };
        return { content: `No picture of that page is available; here is its text instead.\n${short(world.readPage(file.id, args.page as number), MAX_PAGE_CHARS)}`, label };
      }
      case "go_to": {
        const { lesson, section } = needSection(world, args.section as string);
        if (lesson.id !== args.lesson) throw new Refused(`Section "${section.id}" is in lesson "${lesson.id}", not "${String(args.lesson)}"`);
        return { content: `The page now shows "${section.title || lesson.title}".`, action: { kind: "go_to_section", lesson: lesson.id, section: section.id }, label: "Going to the section" };
      }
      case "open_source": {
        const file = needSource(world, args.source as string, args.page as number);
        return { content: `${file.name} is open at page ${args.page} beside the lesson.`, action: { kind: "open_source", source: file.id, page: args.page as number }, label: `Opening ${file.name}` };
      }
      case "ask_me": {
        if (args.section !== undefined) needSection(world, args.section as string);
        const ask = world.ask(args.section as string | undefined);
        return {
          content: `Asked the learner in the page: ${ask.prompt}\nOptions: ${ask.options.join(" | ")}\nStop here and wait for their answer; don't explain or hint at the answer yet.`,
          ask,
          label: "Writing a question for you",
        };
      }
      case "rewrite_for_me": {
        const { section } = needSection(world, args.section as string);
        const block = world.rewrite(section.id, (args.note as string).trim());
        return { content: `Started a personal version of "${section.title}" for the learner; it appears under that section in about a minute. Tell them so briefly.`, block, label: "Rewriting the section for you" };
      }
      case "draw_it": {
        const { section } = needSection(world, args.section as string);
        const block = world.draw(section.id, args.description as string);
        return { content: `Started drawing a diagram under "${section.title}"; it appears in a few seconds.`, block, label: "Drawing a diagram" };
      }
      case "interact": {
        const { section } = needSection(world, args.section as string);
        let spec: unknown;
        try {
          spec = JSON.parse(args.spec as string);
        } catch {
          throw new Refused("spec isn't valid JSON");
        }
        const block = world.interact(section.id, spec);
        return { content: `Added the widget under "${section.title}".`, block, label: "Building a widget" };
      }
      case "storyboard": {
        const { section } = needSection(world, args.section as string);
        const block = world.storyboard(section.id);
        return { content: `Started a short storyboard under "${section.title}"; it appears in about a minute.`, block, label: "Making a storyboard" };
      }
      case "suggest_for_everyone": {
        const { section } = needSection(world, args.section as string);
        world.suggest(section.id, (args.why as string).trim());
        return { content: "Noted for the course's editors.", label: "Telling the editors" };
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A refusal costs the turn another model call; logged (tool and reason only) so the prompts can be tuned.
    console.warn(`tutor tool ${tool} refused: ${reason.slice(0, 300)}`);
    return { content: `Refused: ${reason}`, label: "Checking" };
  }
}
