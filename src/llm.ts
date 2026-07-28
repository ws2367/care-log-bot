import { config } from "./config.js";

// OpenAI-compatible wire types (OpenRouter), shared by the agent and reviewer.

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatChoice {
  message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
  finish_reason: string;
}

interface ChatResponse {
  choices: ChatChoice[];
  error?: { message: string };
}

export async function chatOnce(
  messages: ChatMessage[],
  opts: { tools?: readonly unknown[]; model?: string; maxTokens?: number } = {}
): Promise<ChatChoice> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    try {
      return await chatRequest(messages, opts);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      // Retry once on transient provider errors; rethrow client errors.
      if (!/(?:^|\s)(?:429|5\d\d)|fetch failed|network|timeout/i.test(lastErr.message)) {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error("chatOnce: unreachable");
}

async function chatRequest(
  messages: ChatMessage[],
  opts: { tools?: readonly unknown[]; model?: string; maxTokens?: number }
): Promise<ChatChoice> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/care-log",
      "X-Title": "care-log (Xiao-An)",
    },
    body: JSON.stringify({
      model: opts.model || config.openrouterModel,
      messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      max_tokens: opts.maxTokens ?? 4096,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as ChatResponse;
  if (data.error) throw new Error(`OpenRouter: ${data.error.message}`);
  const choice = data.choices?.[0];
  if (!choice) throw new Error("OpenRouter returned no choices");
  return choice;
}
