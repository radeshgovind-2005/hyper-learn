// S6/S8/S9: Spark tool loop with parallel calls, streamed through LangChain. Never prints the key.
import { AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { env } from "./env.js";
const model = new ChatOpenAI({ model: "muse-spark-1.3", apiKey: env("MODEL_API_KEY"), temperature: 0, timeout: 60_000, maxRetries: 0, configuration: { baseURL: "https://api.meta.ai/v1" }, ...(process.argv[2] && { reasoning: { effort: process.argv[2] as "low" } }) });
const tools = [
  { name: "read_section", description: "Read a section of the learner's lesson by id.", schema: z.object({ id: z.string() }) },
  { name: "read_page", description: "Read one page of a cited source file.", schema: z.object({ source: z.string(), page: z.number().int() }) },
  { name: "go_to", description: "Scroll the learner's page to a section.", schema: z.object({ lesson: z.string(), section: z.string() }) },
];
const bound = model.bindTools(tools);
const messages: BaseMessage[] = [
  new SystemMessage("You are a tutor inside a lesson page. Use tools to read before answering. When you need several independent reads, request them in the same turn. Keep replies under 80 words."),
  new HumanMessage("Lesson numa, sections: numa/intro, numa/remote-memory. Sources: s1 (pages 1-20). The section numa/remote-memory cites s1 p.15 and s1 p.16. I don't get why remote memory is slower. Read the section AND both its pages at once, then explain and take me to the section."),
];
const fake: Record<string, (a: any) => string> = {
  read_section: () => "Remote memory: in NUMA, each processor has local memory. Reaching another node's memory crosses the interconnect, adding latency (s1 p.16).",
  read_page: (a) => (a.page === 15 ? "p15: NUMA nodes each own a memory controller." : "p16: Remote access goes over the interconnect (QPI/UPI): ~1.5-2x the latency of local access."),
  go_to: () => "ok: the page will scroll there",
};
const t0 = Date.now();
for (let step = 0; step < 4; step++) {
  let acc: AIMessageChunk | undefined; let first = 0;
  for await (const chunk of await bound.stream(messages)) {
    if (!first && (chunk.content || chunk.tool_call_chunks?.length)) first = Date.now() - t0;
    acc = acc ? acc.concat(chunk) : chunk;
  }
  const calls = acc!.tool_calls ?? [];
  console.log(`step ${step}: first token ${first}ms, total ${Date.now() - t0}ms, calls ${JSON.stringify(calls.map((c) => [c.name, c.args]))}, text: ${String(acc!.content).slice(0, 300)}`);
  console.log("  usage", JSON.stringify(acc!.usage_metadata));
  if (calls.length === 0) break;
  messages.push(acc!);
  for (const c of calls) messages.push(new ToolMessage({ tool_call_id: c.id!, content: fake[c.name]!(c.args) }));
}
