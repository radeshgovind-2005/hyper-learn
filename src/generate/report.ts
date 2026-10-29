import type { BuildInput, BuildResult } from "./types.js";

// The build report as Markdown, for `npm run generate` (report.md) and for an owner to read before publishing.

const STATUS: Record<string, string> = { ok: "✓", rejected: "✗", info: "·", waiting: "…" };

export function formatReport(input: BuildInput, result: BuildResult): string {
  const { report } = result;
  const lines = [`# ${input.title}: build report`, ""];
  if (result.ok) {
    const { snapshot } = result;
    const items = snapshot.lessons.reduce((n, l) => n + l.quiz.length, 0);
    lines.push(
      `Built **${snapshot.lessons.length} lessons**, ${snapshot.objectives?.length ?? 0} objectives, ${items} exam questions and ${snapshot.misconceptions.length} misconceptions in ${report.model_calls} model calls.`,
      "",
      "## Lessons",
      "",
      ...snapshot.lessons.map(
        (l) => `- **${l.title}** (\`${l.id}\`)${l.prerequisites.length ? `, after ${l.prerequisites.map((p) => `\`${p}\``).join(", ")}` : ""}: ${l.sections.length} sections, ${l.quiz.length} questions`,
      ),
      "",
    );
  } else {
    lines.push(`The course was **not built** (${report.model_calls} model calls).`, "", "## Problems", "", ...result.problems.map((p) => `- ${p}`), "");
  }
  if (report.warnings.length > 0) lines.push("## Warnings", "", ...report.warnings.map((w) => `- ${w}`), "");
  lines.push("## Steps", "");
  for (const step of report.steps) {
    lines.push(`- ${STATUS[step.status] ?? step.status} **${step.stage}**: ${step.title}`);
    if (step.detail) lines.push(...step.detail.split("\n").map((line) => `  ${line}`));
  }
  return `${lines.join("\n")}\n`;
}
