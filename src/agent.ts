import { config, localDateTime } from "./config.js";
import { buildContextBlock, buildSystemPrompt, CATEGORIES, NO_REPLY } from "./prompts.js";
import {
  appendLogEntry,
  listLogFiles,
  readDataFile,
  writeMembers,
  writeProfile,
  type BotContext,
} from "./store.js";

// ── OpenAI-compatible wire types (OpenRouter) ────────────────────────────────

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatResponse {
  choices: Array<{
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  error?: { message: string };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "log_entry",
      description:
        "在指定日期的照護日誌中新增一筆結構化紀錄。與病患狀況相關的資訊都應該記錄。",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "事件發生日期 YYYY-MM-DD（預設今天）" },
          time: { type: "string", description: "事件發生時間 HH:MM（24 小時制）" },
          category: { type: "string", enum: [...CATEGORIES], description: "紀錄類別" },
          title: { type: "string", description: "一句話摘要，例如「午餐吃了半碗粥」" },
          content: {
            type: "string",
            description:
              "詳細內容（markdown）。包含所有已知細節：數值、劑量、持續時間、觀察等。",
          },
          recorder: { type: "string", description: "記錄者稱呼，例如「大女兒 美玲」" },
          attachment_paths: {
            type: "array",
            items: { type: "string" },
            description: "相關附件的 repo 路徑（例如 attachments/2026-07-26-1430-photo-x.jpg）",
          },
        },
        required: ["time", "category", "title", "content", "recorder"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_profile",
      description:
        "覆寫 patient/profile.md（病患基本資料）。請提供整份文件的完整 markdown：保留原有內容並整合新資訊。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "整份 profile.md 的新內容（markdown）" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_members",
      description:
        "覆寫 patient/members.md（家屬成員名單）。請提供整份文件的完整 markdown，保留既有成員的資料。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "整份 members.md 的新內容（markdown）" },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "讀取資料庫中的檔案（patient/、logs/、attachments/ 底下）。用於查閱七天前的舊日誌。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "例如 logs/2026-06-01.md" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_logs",
      description: "列出所有日誌檔案名稱（logs/ 目錄），用來找出有哪些日期有紀錄。",
      parameters: { type: "object", properties: {} },
    },
  },
] as const;

// ── Tool execution ───────────────────────────────────────────────────────────

interface LogEntryArgs {
  date?: string;
  time: string;
  category: string;
  title: string;
  content: string;
  recorder: string;
  attachment_paths?: string[];
}

async function executeTool(name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return "錯誤：工具參數不是有效的 JSON。";
  }

  try {
    switch (name) {
      case "log_entry": {
        const a = args as unknown as LogEntryArgs;
        const date = a.date || localDateTime().date;
        const attachments = (a.attachment_paths ?? [])
          .map((p) => `- 附件：![[${p}]]`)
          .join("\n");
        const entry = [
          `## ${a.time}｜${a.category}｜${a.title}`,
          ``,
          `- 記錄者：${a.recorder}`,
          ``,
          a.content.trim(),
          attachments,
        ]
          .filter(Boolean)
          .join("\n");
        const path = await appendLogEntry(date, entry);
        return `已寫入 ${path}`;
      }
      case "update_profile": {
        await writeProfile(String(args.content ?? ""));
        return "已更新 patient/profile.md";
      }
      case "update_members": {
        await writeMembers(String(args.content ?? ""));
        return "已更新 patient/members.md";
      }
      case "read_file": {
        const content = await readDataFile(String(args.path ?? ""));
        return content ?? "（檔案不存在或路徑不允許）";
      }
      case "list_logs": {
        const files = await listLogFiles();
        return files.length > 0 ? files.join("\n") : "（目前沒有任何日誌）";
      }
      default:
        return `錯誤：未知的工具 ${name}`;
    }
  } catch (err) {
    return `工具執行失敗：${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── OpenRouter call ──────────────────────────────────────────────────────────

async function chatCompletion(messages: ChatMessage[]): Promise<ChatResponse["choices"][0]> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/care-log",
      "X-Title": "care-log (Xiao-An)",
    },
    body: JSON.stringify({
      model: config.openrouterModel,
      messages,
      tools: TOOLS,
      max_tokens: 4096,
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

// ── Public entry point ───────────────────────────────────────────────────────

export interface IncomingMessage {
  senderUserId: string;
  senderName: string;
  /** Text of the message; for voice, the transcript; for images, optional caption. */
  text: string;
  /** Base64 data-URL images attached to this message. */
  images?: Array<{ dataUrl: string; repoPath: string }>;
  /** Repo path of a saved voice attachment, if any. */
  audioPath?: string;
}

/**
 * Run the agent loop for one incoming message.
 * Returns the bot's reply text, or null when the bot chooses to stay silent.
 */
export async function runAgent(ctx: BotContext, incoming: IncomingMessage): Promise<string | null> {
  const now = localDateTime();

  const priorTurns: ChatMessage[] = ctx.turns.map((t) => ({
    role: t.role,
    content:
      t.role === "user" ? `[${t.at}] ${t.name ?? "家屬"}：${t.text}` : t.text,
  }));

  const userParts: ContentPart[] = [];
  let header = `[現在 ${now.date} ${now.time}] 傳訊者：${incoming.senderName}（LINE ID: ${incoming.senderUserId}）`;
  if (incoming.audioPath) header += `\n（語音訊息，已存為 ${incoming.audioPath}，以下為逐字稿）`;
  if (incoming.images?.length) {
    header += `\n（附 ${incoming.images.length} 張照片，已存為：${incoming.images
      .map((i) => i.repoPath)
      .join("、")}）`;
  }
  userParts.push({ type: "text", text: `${header}\n\n${incoming.text}` });
  for (const img of incoming.images ?? []) {
    userParts.push({ type: "image_url", image_url: { url: img.dataUrl } });
  }

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(now) },
    { role: "system", content: buildContextBlock(ctx) },
    ...priorTurns,
    { role: "user", content: userParts },
  ];

  const MAX_ITERATIONS = 8;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const choice = await chatCompletion(messages);
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });
      for (const call of msg.tool_calls) {
        const result = await executeTool(call.function.name, call.function.arguments);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      continue;
    }

    const text = (msg.content ?? "").trim();
    if (!text || text === NO_REPLY || text.includes(NO_REPLY)) return null;
    // LINE renders plain text only — strip markdown emphasis/heading markers
    // in case the model slips them in despite the prompt.
    return text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#{1,4}\s+/gm, "")
      .trim();
  }

  return "抱歉，這則訊息我處理得有點久，請再傳一次好嗎？🙏";
}
