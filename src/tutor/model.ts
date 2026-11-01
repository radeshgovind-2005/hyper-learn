import { AIMessage, type AIMessageChunk, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
import type { ModelStep, ToolSpec, TutorMessage, TutorModel } from "./types.js";

// The tutor's model step on a chat model with tools (Muse Spark through the OpenAI-compatible API).
// Spark streams text and tool calls as chunks; they are concatenated into one message. A page picture
// can't go in a tool result (the API takes text there), so it follows as a user message with the image.

function toLangChain(messages: readonly TutorMessage[]): BaseMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case "system":
        return new SystemMessage(m.content);
      case "user":
        return m.image
          ? new HumanMessage({ content: [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: `data:${m.image.mime};base64,${m.image.base64}` } }] })
          : new HumanMessage(m.content);
      case "assistant":
        return new AIMessage({ content: m.content, tool_calls: m.calls.map((c) => ({ id: c.id, name: c.name, args: (c.args ?? {}) as Record<string, unknown>, type: "tool_call" as const })) });
      case "tool":
        return new ToolMessage({ tool_call_id: m.call_id, name: m.name, content: m.content });
    }
  });
}

export function chatTutorModel(chat: ChatOpenAI): TutorModel {
  return {
    async step(messages, tools: readonly ToolSpec[], onText, signal): Promise<ModelStep> {
      const bound = chat.bindTools(tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })));
      let message: AIMessageChunk | undefined;
      for await (const chunk of await bound.stream(toLangChain(messages), { signal })) {
        if (typeof chunk.content === "string" && chunk.content) onText(chunk.content);
        message = message ? message.concat(chunk) : chunk;
      }
      const text = typeof message?.content === "string" ? message.content : "";
      const calls = (message?.tool_calls ?? []).map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, args: c.args }));
      return { text, calls };
    },
  };
}
