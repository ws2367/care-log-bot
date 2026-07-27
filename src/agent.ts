import { localDateTime } from "./config.js";
import { chatOnce, type ChatMessage, type ContentPart } from "./llm.js";
import { buildContextBlock, buildSystemPrompt, CATEGORIES, NO_REPLY } from "./prompts.js";
import {
  appendLogEntry,
  editDataFile,
  listLogFiles,
  readDataFile,
  writeInstructions,
  writeMembers,
  writeProfile,
  type BotContext,
} from "./store.js";

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
      name: "edit_file",
      description:
        "覆寫 logs/、patient/ 或 prompts/ 底下的 markdown 檔案（必須提供整份檔案的新內容）。用於修正錯誤（時間、數值、記錄者）、合併或刪除重複條目、補充細節到既有條目、整理格式。現有內容可從 <recent_logs> 取得，較舊的檔案先用 read_file 讀取。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "例如 logs/2026-07-27.md" },
          content: { type: "string", description: "整份檔案修改後的完整內容（markdown）" },
          reason: { type: "string", description: "一句話說明改了什麼，例如「刪除 19:00 重複的晚餐紀錄」" },
        },
        required: ["path", "content", "reason"],
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
      name: "update_instructions",
      description:
        "覆寫 prompts/custom.md（家屬自訂指示）。當家屬提出長期性的偏好或規則（「以後都要…」「不要再…」，例如回覆風格、記錄格式、提醒事項），把它整理進這份文件，之後每次對話、所有聊天室都會遵守。提供整份文件的完整新內容，保留仍然有效的舊指示。",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "整份自訂指示的新內容（markdown 條列）",
          },
        },
        required: ["content"],
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

const WRITE_TOOLS = new Set([
  "log_entry",
  "edit_file",
  "update_profile",
  "update_members",
  "update_instructions",
]);

/** Matches replies that claim something was recorded/updated/deleted. */
const CLAIMS_WRITE = /已記錄|已更新|已刪除|已寫入|記下來|記錄了|紀錄了|已修改|已補充/;

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
      case "update_instructions": {
        await writeInstructions(String(args.content ?? ""));
        return "已更新 prompts/custom.md";
      }
      case "edit_file": {
        const err = await editDataFile(
          String(args.path ?? ""),
          String(args.content ?? ""),
          String(args.reason ?? "修改紀錄")
        );
        return err ?? `已更新 ${args.path}`;
      }
      case "update_instructions": {
        await writeInstructions(String(args.content ?? ""));
        return "已更新 prompts/custom.md";
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

export interface AgentResult {
  /** Reply text, or null when the bot chooses to stay silent. */
  reply: string | null;
  /** Repo files successfully written during this run. */
  wrote: string[];
}

/** Run the agent loop for one incoming message. */
export async function runAgent(ctx: BotContext, incoming: IncomingMessage): Promise<AgentResult> {
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
    { role: "system", content: buildSystemPrompt(now, ctx.instructions) },
    { role: "system", content: buildContextBlock(ctx) },
    ...priorTurns,
    { role: "user", content: userParts },
  ];

  const wrote: string[] = [];
  let guarded = false;

  const MAX_ITERATIONS = 10;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const choice = await chatOnce(messages, { tools: TOOLS });
    const msg = choice.message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls,
      });
      for (const call of msg.tool_calls) {
        const result = await executeTool(call.function.name, call.function.arguments);
        const written = result.match(/^已(?:寫入|更新)\s+(\S+)/);
        if (WRITE_TOOLS.has(call.function.name) && written?.[1]) wrote.push(written[1]);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
      continue;
    }

    const text = (msg.content ?? "").trim();
    if (!text || text === NO_REPLY || text.includes(NO_REPLY)) return { reply: null, wrote };

    // Write-guard: the model may claim "已記錄" without having called any
    // write tool (it imitates its own past replies). Push back once and let
    // it either actually write or correct its answer.
    if (wrote.length === 0 && CLAIMS_WRITE.test(text) && !guarded) {
      guarded = true;
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "system",
        content:
          "（系統提醒）你這回合尚未呼叫任何寫入工具，檔案完全沒有變更。" +
          "如果你剛才聲稱已記錄／已更新的內容還不存在於 <recent_logs> 的檔案裡，" +
          "請現在就用 log_entry 或 edit_file 實際寫入，完成後再回覆家屬。" +
          "如果內容確實已在檔案中，請照實回答即可。絕不能在沒有寫入的情況下宣稱已記錄。",
      });
      continue;
    }

    // LINE renders plain text only — strip markdown emphasis/heading markers
    // in case the model slips them in despite the prompt.
    const cleaned = text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#{1,4}\s+/gm, "")
      .trim();
    return { reply: cleaned, wrote };
  }

  return { reply: "抱歉，這則訊息我處理得有點久，請再傳一次好嗎？🙏", wrote };
}
