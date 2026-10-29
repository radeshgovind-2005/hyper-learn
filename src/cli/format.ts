import type { NodePerformance } from "../state.js";

// Terminal output shared by `npm run eval` and `npm run loop`.

export const describeMutation = (m?: {
  action: string;
  node_id: string | null;
  target_node_id: string | null;
  misconception_id: string | null;
}) =>
  m
    ? `${m.action}(${m.node_id ?? "any"}${m.target_node_id ? ` ← ${m.target_node_id}` : ""}` +
      `${m.misconception_id ? ` : ${m.misconception_id}` : ""})`
    : "—";

export function printData(data: NodePerformance[]) {
  for (const node of data) {
    const top = node.gaps.map((m) => `${m.points_to} ${Math.round(m.share * 100)}%`).join(", ");
    const beliefs = node.misconceptions
      .map((m) => `${m.id} ${Math.round(m.share * 100)}% (${Math.round(m.confident * 100)}% sure)`)
      .join(", ");
    console.log(
      `  ${node.node_id.padEnd(18)} ${String(node.attempts).padStart(4)} attempts  fail ${node.fail_rate.toFixed(2)}` +
        `${node.low_sample ? " (low sample)" : ""}  wrong answers → ${top}`,
    );
    if (beliefs) console.log(`  ${"".padEnd(18)} beliefs: ${beliefs}`);
    if (node.excluded_items.length > 0) console.log(`  ${"".padEnd(18)} excluded broken items: ${node.excluded_items.join(", ")}`);
  }
}
