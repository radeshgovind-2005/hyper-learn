import type { TutorAction } from "../media/contracts.js";
import { runTool, TOOL_SPECS, type TutorWorld } from "./tools.js";
import type { PersonalBlockRef, TutorAsk, TutorEvent, TutorMessage, TutorModel, TutorTurnResult } from "./types.js";

// One tutor turn: a bounded tool loop. The model reads, then answers or chooses tools; code runs the
// tools and stops the loop at the call budget, on a timeout, or when a question is put to the learner
// (the turn ends there and waits for their answer).

/** Model calls one turn may make. */
export const MAX_TURN_CALLS = 6;
/** Tool calls one model step may make; more are refused (they would multiply the work of one call). */
export const MAX_CALLS_PER_STEP = 6;
/** Each model call's time limit. */
export const TURN_CALL_TIMEOUT_MS = 60_000;

export interface TurnOptions {
  model: TutorModel;
  world: TutorWorld;
  system: string;
  /** This turn's context (lesson, section in view, pages, what was missed), built by code. */
  context: string;
  /** Earlier messages in the window, oldest first. */
  history: readonly { role: "user" | "assistant"; text: string }[];
  text: string;
  maxCalls?: number;
  timeoutMs?: number;
  onEvent?: (event: TutorEvent) => void;
  /** Applied to the reply before it is returned (the answer-key guard). */
  guard?: (reply: string) => string;
}

const WAIT_FOR_ANSWER = "One quick question first: answer it here and I'll take it from there.";

function timeout<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`The model took longer than ${Math.round(ms / 1000)} s`));
    }, ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export async function runTurn(options: TurnOptions): Promise<TutorTurnResult> {
  const { model, world, onEvent } = options;
  const maxCalls = options.maxCalls ?? MAX_TURN_CALLS;
  const guard = options.guard ?? ((reply: string) => reply);
  const messages: TutorMessage[] = [
    { role: "system", content: options.system },
    ...options.history.map((m) => (m.role === "user" ? { role: "user" as const, content: m.text } : { role: "assistant" as const, content: m.text, calls: [] })),
    { role: "user", content: `${options.context}\n\nThe learner says: ${options.text}` },
  ];
  const actions: TutorAction[] = [];
  const blocks: PersonalBlockRef[] = [];
  let ask: TutorAsk | undefined;
  let calls = 0;
  const finish = (reply: string, stopped?: string): TutorTurnResult => ({
    reply: guard(reply.trim() || (blocks.length > 0 ? "I'm making that for you now; it will appear in the page." : "Done.")),
    actions,
    blocks,
    ...(ask && { ask }),
    model_calls: calls,
    ...(stopped && { stopped }),
  });

  onEvent?.({ type: "step", label: "Reading the lesson" });
  while (calls < maxCalls) {
    calls++;
    const controller = new AbortController();
    let step;
    try {
      step = await timeout(model.step(messages, TOOL_SPECS, (delta) => onEvent?.({ type: "text", delta }), controller.signal), options.timeoutMs ?? TURN_CALL_TIMEOUT_MS, controller);
    } catch (error) {
      return finish("Sorry, I couldn't finish that just now. Try again in a moment.", error instanceof Error ? error.message : String(error));
    }
    if (step.calls.length === 0) return finish(step.text);

    messages.push({ role: "assistant", content: step.text, calls: step.calls });
    const images: TutorMessage[] = [];
    for (const [i, call] of step.calls.entries()) {
      if (i >= MAX_CALLS_PER_STEP) {
        messages.push({ role: "tool", call_id: call.id, name: call.name, content: `Error: at most ${MAX_CALLS_PER_STEP} tool calls per step` });
        continue;
      }
      const result = await runTool(world, call.name, call.args);
      onEvent?.({ type: "step", label: result.label });
      messages.push({ role: "tool", call_id: call.id, name: call.name, content: result.content });
      if (result.image) images.push({ role: "user", content: result.content, image: result.image });
      if (result.action) actions.push(result.action);
      if (result.block) blocks.push(result.block);
      if (result.ask) ask = result.ask;
    }
    messages.push(...images);
    // A question is out: the turn waits for the learner's answer instead of explaining.
    if (ask) return finish(step.text || WAIT_FOR_ANSWER);
  }
  return finish(
    blocks.length > 0 || actions.length > 0 ? "I've set that up for you in the page." : "I ran out of steps for this question. Could you ask it a narrower way?",
    `Stopped after ${calls} model calls (the limit for one turn)`,
  );
}
