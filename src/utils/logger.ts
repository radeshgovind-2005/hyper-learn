const NODE_TAGS = {
  supervisor: "🟢 [Supervisor]",
  assistant: "🔵 [Assistant]",
  tools: "🛠️  [Tools]",
  curator: "🟣 [Curator]",
  reflection: "🟠 [Reflection]",
} as const;

export type LoggedNode = keyof typeof NODE_TAGS;

/** Uniform, tagged console output so the graph flow is easy to follow in the terminal. */
export function logNode(node: LoggedNode, message: string, data?: unknown): void {
  const line = `${NODE_TAGS[node]} ${message}`;
  if (data === undefined) {
    console.log(line);
  } else {
    console.log(line, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}
