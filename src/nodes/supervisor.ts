import type { Route, State, StateUpdate } from "../state.js";
import { logNode } from "../utils/logger.js";

const ROUTES: Record<State["input_type"], Route> = {
  cron: "curator",
  user_question: "assistant",
};

/** Deterministic router: system triggers go to the Curator, learner questions to the Assistant. */
export async function supervisorNode(state: State): Promise<StateUpdate> {
  const route = ROUTES[state.input_type];
  logNode("supervisor", `input_type="${state.input_type}" → routing to ${route}`);
  return { route };
}

export function routeFromSupervisor(state: State): Route {
  if (!state.route) throw new Error("Supervisor did not set a route");
  return state.route;
}
