import type { PrereqGraph } from "./schema.js";

/** Returns one cycle as a list of ids (first id repeated at the end), or null if the graph is acyclic. */
export function findCycle(graph: PrereqGraph): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (state.get(id) === "done") return null;
    if (state.get(id) === "visiting") return [...path.slice(path.indexOf(id)), id];

    state.set(id, "visiting");
    path.push(id);
    for (const prereq of graph[id] ?? []) {
      const cycle = visit(prereq);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, "done");
    return null;
  };

  for (const id of Object.keys(graph)) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

/** Every lesson `id` depends on, directly or transitively. */
export function ancestorsOf(graph: PrereqGraph, id: string): Set<string> {
  const ancestors = new Set<string>();
  const stack = [...(graph[id] ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (ancestors.has(next)) continue;
    ancestors.add(next);
    stack.push(...(graph[next] ?? []));
  }
  return ancestors;
}

/** Lessons that list `id` as a direct prerequisite. */
export function dependentsOf(graph: PrereqGraph, id: string): string[] {
  return Object.keys(graph).filter((other) => graph[other]?.includes(id));
}

/** True if making `prereq` a prerequisite of `id` would create a cycle. */
export function wouldCreateCycle(graph: PrereqGraph, id: string, prereq: string): boolean {
  return prereq === id || ancestorsOf(graph, prereq).has(id);
}

/** A topological order (prerequisites first), choosing among available lessons with `random`. */
export function randomTopologicalOrder(graph: PrereqGraph, random: () => number): string[] {
  const done = new Set<string>();
  const order: string[] = [];
  const ids = Object.keys(graph);

  while (order.length < ids.length) {
    const available = ids.filter((id) => !done.has(id) && (graph[id] ?? []).every((p) => done.has(p)));
    if (available.length === 0) throw new Error("Graph has a cycle; no topological order exists");
    const next = available[Math.floor(random() * available.length)]!;
    done.add(next);
    order.push(next);
  }
  return order;
}
