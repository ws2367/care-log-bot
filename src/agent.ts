import { Agent as PiAgent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { config, localDateTime } from "./config.js";
import { chatOnce } from "./llm.js";
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
import {
  delayEvent,
  loadPlan,
  nowMinutes,
  recordEvent,
  renderPlanForAgent,
  saveRoutines,
} from "./schedule.js";

// ── Model runtime (Pi) ───────────────────────────────────────────────────────
// pi-ai resolves the OpenRouter key from the OPENROUTER_API_KEY env var.

let modelsSingleton: ReturnType<typeof createModels> | null = null;

function models(): ReturnType<typeof createModels> {
  if (!modelsSingleton) {
    modelsSingleton = createModels();
    modelsSingleton.setProvider(openrouterProvider());
  }
  return modelsSingleton;
}

function getModel() {
  const m = models().getModel("openrouter", config.openrouterModel);
  if (!m) {
    throw new Error(
      `模型 ${config.openrouterModel} 不在 Pi 的 OpenRouter 目錄中 — 請改用目錄內的模型 ID（OPENROUTER_MODEL）`
    );
  }
  return m;
}

// ── Tool execution (shared implementations) ──────────────────────────────────

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
  "record_routine",
  "delay_routine",
  "update_routines",
]);

/**
 * LLM-based write-claim detection (replaces the old regex vocabulary, which
 * could never keep up with phrasings). Asks a small fast model whether the
 * draft claims a completed write action or promises a future one. Fails open
 * (returns false) on classifier errors — the reviewer still backstops.
 */
async function claimsWriteAction(draft: string): Promise<boolean> {
  try {
    const choice = await chatOnce(
      [
        {
          role: "system",
          content:
            "你是二元分類器。判斷給定的訊息是否「宣稱已完成」或「承諾將進行」任何資料異動類動作——" +
            "例如：記錄、寫入、更新、修改、刪除、補充、調整行程、安排時間、標記完成。" +
            "單純回答問題、轉述既有資料、詢問細節、閒聊，都算 false。" +
            '只輸出 JSON：{"claims":true} 或 {"claims":false}。',
        },
        { role: "user", content: draft },
      ],
      { model: config.guardModel, maxTokens: 24 }
    );
    const raw = (choice.message.content ?? "").trim();
    return /"claims"\s*:\s*true/.test(raw);
  } catch (err) {
    console.error("write-claim classifier failed; skipping guard", err);
    return false;
  }
}

async function executeToolImpl(name: string, args: Record<string, unknown>): Promise<string> {
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
        (a.content ?? "").trim(),
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
      if (err) throw new Error(err);
      return `已更新 ${args.path}`;
    }
    case "read_file": {
      const content = await readDataFile(String(args.path ?? ""));
      return content ?? "（檔案不存在或路徑不允許）";
    }
    case "list_logs": {
      const files = await listLogFiles();
      return files.length > 0 ? files.join("\n") : "（目前沒有任何日誌）";
    }
    case "get_schedule": {
      const date = String(args.date ?? "") || localDateTime().date;
      const plan = await loadPlan(date);
      return renderPlanForAgent(plan, nowMinutes());
    }
    case "record_routine": {
      const date = String(args.date ?? "") || localDateTime().date;
      const status = args.status === "skipped" ? "skipped" : "done";
      const actual = String(args.actual_time ?? "") || localDateTime().time;
      const res = await recordEvent(
        date,
        String(args.eid ?? ""),
        status,
        actual,
        args.note ? String(args.note) : undefined,
        args.shift_followups === true
      );
      if (!res.ok) throw new Error(res.message);
      return res.message;
    }
    case "delay_routine": {
      const date = String(args.date ?? "") || localDateTime().date;
      const res = await delayEvent(
        date,
        String(args.eid ?? ""),
        String(args.new_time ?? ""),
        args.note ? String(args.note) : undefined,
        args.cascade !== false
      );
      if (!res.ok) throw new Error(res.message);
      return res.message;
    }
    case "update_routines": {
      const err = await saveRoutines(String(args.content ?? ""));
      if (err) throw new Error(err);
      return "已更新 schedule/routines.json";
    }
    default:
      throw new Error(`未知的工具 ${name}`);
  }
}

// ── Pi tool definitions ──────────────────────────────────────────────────────

const categoryLiterals = CATEGORIES.map((c) => Type.Literal(c));

const TOOL_DEFS: Array<{
  name: string;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
}> = [
  {
    name: "log_entry",
    label: "新增日誌紀錄",
    description: "在指定日期的照護日誌中新增一筆結構化紀錄。與病患狀況相關的資訊都應該記錄。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "事件發生日期 YYYY-MM-DD（預設今天）" })),
      time: Type.String({ description: "事件發生時間 HH:MM（24 小時制）" }),
      category: Type.Union(categoryLiterals, { description: "紀錄類別" }),
      title: Type.String({ description: "一句話摘要，例如「午餐吃了半碗粥」" }),
      content: Type.String({
        description: "詳細內容（markdown）。包含所有已知細節：數值、劑量、持續時間、觀察等。",
      }),
      recorder: Type.String({ description: "記錄者稱呼，例如「大女兒 美玲」" }),
      attachment_paths: Type.Optional(
        Type.Array(Type.String(), { description: "相關附件的 repo 路徑" })
      ),
    }),
  },
  {
    name: "update_profile",
    label: "更新病患資料",
    description:
      "覆寫 patient/profile.md（病患基本資料）。請提供整份文件的完整 markdown：保留原有內容並整合新資訊。",
    parameters: Type.Object({
      content: Type.String({ description: "整份 profile.md 的新內容（markdown）" }),
    }),
  },
  {
    name: "update_members",
    label: "更新家屬名單",
    description:
      "覆寫 patient/members.md（家屬成員名單）。請提供整份文件的完整 markdown，保留既有成員的資料。",
    parameters: Type.Object({
      content: Type.String({ description: "整份 members.md 的新內容（markdown）" }),
    }),
  },
  {
    name: "update_instructions",
    label: "更新自訂指示",
    description:
      "覆寫 prompts/custom.md（家屬自訂指示）。當家屬提出長期性的偏好或規則時，把它整理進這份文件，之後每次對話、所有聊天室都會遵守。提供整份文件的完整新內容，保留仍然有效的舊指示。",
    parameters: Type.Object({
      content: Type.String({ description: "整份自訂指示的新內容（markdown 條列）" }),
    }),
  },
  {
    name: "edit_file",
    label: "編輯檔案",
    description:
      "覆寫 logs/、patient/ 或 prompts/ 底下的 markdown 檔案（必須提供整份檔案的新內容）。用於修正錯誤、合併或刪除重複條目、補充細節到既有條目。現有內容可從 <recent_logs> 取得，較舊的檔案先用 read_file 讀取。",
    parameters: Type.Object({
      path: Type.String({ description: "例如 logs/2026-08-17.md" }),
      content: Type.String({ description: "整份檔案修改後的完整內容（markdown）" }),
      reason: Type.String({ description: "一句話說明改了什麼" }),
    }),
  },
  {
    name: "read_file",
    label: "讀取檔案",
    description: "讀取資料庫中的檔案（patient/、logs/、attachments/、prompts/ 底下）。用於查閱七天前的舊日誌。",
    parameters: Type.Object({
      path: Type.String({ description: "例如 logs/2026-06-01.md" }),
    }),
  },
  {
    name: "list_logs",
    label: "列出日誌檔案",
    description: "列出所有日誌檔案名稱（logs/ 目錄），用來找出有哪些日期有紀錄。",
    parameters: Type.Object({}),
  },
  {
    name: "get_schedule",
    label: "查看行程表",
    description:
      "查看某日的照護例行行程表（餵食、吃藥、翻身、尿布檢查、擦澡、拍痰、抽痰、復健），含每個項目的 eid、預定時間、輪替姿勢與完成狀態。回答「下一個行程」或標記完成/延遲之前，先用這個工具。",
    parameters: Type.Object({
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD（預設今天）" })),
    }),
  },
  {
    name: "record_routine",
    label: "標記行程完成",
    description:
      "標記某個例行行程項目為完成或略過（記錄實際時間）。家屬回報「餵好了」「剛翻完身」時使用。不會影響其他行程時間。值得保存的細節另外用 log_entry 記錄。",
    parameters: Type.Object({
      eid: Type.String({ description: "行程項目 ID，例如 feeding-2（先用 get_schedule 查）" }),
      status: Type.Union([Type.Literal("done"), Type.Literal("skipped")]),
      actual_time: Type.Optional(Type.String({ description: "實際完成時間 HH:MM（預設現在）" })),
      shift_followups: Type.Optional(
        Type.Boolean({
          description:
            "true＝實際時間比預定晚（或早）時，後續同類待辦行程依同樣差距順延、保持間隔。家屬回報做晚了而且之後要照間隔走時使用。",
        })
      ),
      note: Type.Optional(Type.String({ description: "備註，例如「水 200ml」" })),
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD（預設今天）" })),
    }),
  },
  {
    name: "delay_routine",
    label: "延遲行程",
    description:
      "把某個例行行程延到新時間；當天「後續同類」的行程會自動往後推同樣的時間，保持間隔（附掛項目如吃藥、尿布檢查、拍痰跟著移動）。回覆家屬時要告知連動調整後的新時間。",
    parameters: Type.Object({
      eid: Type.String({ description: "要延遲的行程項目 ID（先用 get_schedule 查）" }),
      new_time: Type.String({ description: "新的預定時間 HH:MM" }),
      cascade: Type.Optional(
        Type.Boolean({
          description:
            "true（預設）＝進度延誤：後續同類行程一起順延、保持間隔。false＝單次改期：只改這一個事件，其他行程不動（例如「今天抽痰改到兩點」）。",
        })
      ),
      note: Type.Optional(Type.String({ description: "延遲原因（可省略）" })),
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD（預設今天）" })),
    }),
  },
  {
    name: "update_routines",
    label: "更新行程規則",
    description:
      "覆寫例行行程的「規則設定」schedule/routines.json（提供完整 JSON）。用於長期調整：改時間表、增減次數、改水量或注意事項。當天已產生的行程表不會自動重排（需要的話另用 delay_routine 調整今天）。chain=有自己時間表的行程（times: [\"HH:MM\"...]，可選 cycle 輪替標籤）；rider=附掛在 chain 上的行程（parent + 可選 onEvents 索引）。",
    parameters: Type.Object({
      content: Type.String({ description: "整份 routines.json 的新內容（JSON 字串）" }),
    }),
  },
];

/** Build per-run Pi tools tracking writes into `wrote` and all calls into `trace`. */
function buildTools(wrote: string[], trace: string[]): AgentTool[] {
  return TOOL_DEFS.map((def) => ({
    name: def.name,
    label: def.label,
    description: def.description,
    parameters: def.parameters,
    execute: async (_toolCallId: string, params: unknown) => {
      const argsBrief = JSON.stringify(params ?? {}).slice(0, 160);
      try {
        const result = await executeToolImpl(def.name, (params ?? {}) as Record<string, unknown>);
        if (WRITE_TOOLS.has(def.name)) {
          const written = result.match(/^已(?:寫入|更新)\s+(\S+)/);
          if (written?.[1]) wrote.push(written[1]);
        }
        trace.push(`${def.name}(${argsBrief}) → ${result.split("\n")[0]?.slice(0, 160)}`);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        trace.push(`${def.name}(${argsBrief}) → 失敗：${msg.slice(0, 160)}`);
        throw err;
      }
    },
  }));
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

/** Full working state of a run — kept so the reviewer can send the agent back. */
export interface AgentState {
  agent: PiAgent;
  wrote: string[];
  /** Every tool call this run (including read-only), for reviewer evidence. */
  trace: string[];
}

export interface AgentResult {
  /** Reply text, or null when the bot chooses to stay silent. */
  reply: string | null;
  /** Repo files successfully written during this run (accumulated across iterations). */
  wrote: string[];
  /** Pass to continueAgent() to iterate after reviewer feedback. */
  state: AgentState;
}

function parseDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m || !m[1] || !m[2]) return null;
  return { mimeType: m[1], data: m[2] };
}

function lastAssistantText(agent: PiAgent): string {
  const last = agent.state.messages.at(-1);
  if (!last || last.role !== "assistant") return "";
  if (last.errorMessage) throw new Error(`LLM 錯誤：${last.errorMessage}`);
  return last.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

/** Prompt with one retry via continue() on transient provider errors. */
async function promptSafe(
  agent: PiAgent,
  text: string,
  images?: Array<{ type: "image"; data: string; mimeType: string }>
): Promise<void> {
  try {
    await agent.prompt(text, images);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await agent.continue();
    } catch {
      throw err;
    }
  }
}

/**
 * Shared finalization: run the write-guard against the final draft, bouncing
 * the run back into the agent (max 2 rounds) when it claims/promises writes
 * that never happened. Returns the cleaned reply or null (deliberate silence).
 */
async function finalize(state: AgentState): Promise<AgentResult> {
  let guardRounds = 0;
  for (;;) {
    const text = lastAssistantText(state.agent);
    if (!text || text === NO_REPLY || text.includes(NO_REPLY)) {
      return { reply: null, wrote: state.wrote, state };
    }
    if (state.wrote.length === 0 && guardRounds < 2 && (await claimsWriteAction(text))) {
      guardRounds++;
      await promptSafe(
        state.agent,
        "（系統提醒，此訊息不是家屬傳的）你這回合尚未成功呼叫任何寫入工具，檔案完全沒有變更。" +
          "不可以「承諾稍後記錄」——如果有該記錄的內容，現在就用 log_entry 或 edit_file 實際寫入，完成後再回覆家屬。" +
          "如果內容確實已在 <recent_logs> 的檔案中，或這則訊息本來就不需要記錄，請照實回覆即可。" +
          "絕不能在沒有寫入的情況下宣稱或承諾記錄。"
      );
      continue;
    }
    const cleaned = text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#{1,4}\s+/gm, "")
      .replace(/〔本回合[^〕]*〕/g, "")
      .trim();
    return { reply: cleaned, wrote: state.wrote, state };
  }
}

/** Run the agent loop for one incoming message. */
export async function runAgent(ctx: BotContext, incoming: IncomingMessage): Promise<AgentResult> {
  const now = localDateTime();

  const history =
    ctx.turns.length > 0
      ? ctx.turns
          .map((t) => `[${t.at}] ${t.role === "user" ? (t.name ?? "家屬") : "小安"}：${t.text}`)
          .join("\n")
      : "（這個聊天室還沒有先前的對話）";

  const systemPrompt = [
    buildSystemPrompt(now, ctx.instructions),
    buildContextBlock(ctx),
    `<conversation_history>\n${history}\n</conversation_history>`,
  ].join("\n\n");

  const wrote: string[] = [];
  const trace: string[] = [];
  let turns = 0;
  const agent = new PiAgent({
    initialState: {
      systemPrompt,
      model: getModel(),
      tools: buildTools(wrote, trace),
      messages: [],
    },
    streamFn: models().streamSimple.bind(models()),
    // Hard ceiling against runaway tool loops.
    shouldStopAfterTurn: async () => ++turns >= 12,
  });

  let header = `[現在 ${now.date} ${now.time}] 傳訊者：${incoming.senderName}（LINE ID: ${incoming.senderUserId}）`;
  if (incoming.audioPath) header += `\n（語音訊息，已存為 ${incoming.audioPath}，以下為逐字稿）`;
  if (incoming.images?.length) {
    header += `\n（附 ${incoming.images.length} 張照片，已存為：${incoming.images
      .map((i) => i.repoPath)
      .join("、")}）`;
  }

  const images = (incoming.images ?? [])
    .map((i) => parseDataUrl(i.dataUrl))
    .filter((i): i is { data: string; mimeType: string } => i !== null)
    .map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));

  const state: AgentState = { agent, wrote, trace };
  await promptSafe(agent, `${header}\n\n${incoming.text}`, images.length > 0 ? images : undefined);
  return finalize(state);
}

/**
 * Resume a prior run with reviewer feedback. The agent keeps its complete
 * state (tool calls, results, drafts), so it can fix exactly what the
 * reviewer flagged — write what it claimed, or restate what it actually did.
 */
export async function continueAgent(state: AgentState, feedback: string): Promise<AgentResult> {
  await promptSafe(
    state.agent,
    `（內部審核回饋，此訊息不是家屬傳的）審核員退回了你的回覆：${feedback}\n` +
      "請據此修正：該寫入而尚未寫入的內容，現在就呼叫工具完成；已做過的變更要在回覆中如實描述。" +
      "修正完成後，重新給出要傳給家屬的最終回覆。"
  );
  return finalize(state);
}
