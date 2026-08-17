import { listDir, readFile, writeFile } from "./github.js";
import { localDateTime } from "./config.js";

// Repo layout (inside DATA_ROOT):
//   patient/profile.md      — patient basics (name, diagnosis, meds, allergies…)
//   patient/members.md      — family members: LINE userId → name, relationship
//   logs/YYYY-MM-DD.md      — one file per day, entries appended as sections
//   attachments/…           — photos/audio referenced from logs
//   .state/conversations/…  — per-chat rolling transcript (hidden from Obsidian)

export const PATHS = {
  profile: "patient/profile.md",
  members: "patient/members.md",
  instructions: "prompts/custom.md",
  logDir: "logs",
  attachmentDir: "attachments",
  log: (date: string) => `logs/${date}.md`,
  conversation: (chatId: string) => `.state/conversations/${chatId}.json`,
};

const PROFILE_TEMPLATE = `# 病患基本資料

> 尚未填寫。請在 LINE 上告訴小安病患的基本資料（姓名、年齡、診斷、目前治療、用藥、過敏史等），小安會自動整理到這裡。
`;

const MEMBERS_TEMPLATE = `# 家屬成員

> 小安會在這裡記錄每位家屬的 LINE 帳號、稱呼與病患的關係。

| LINE User ID | 顯示名稱 | 稱呼 | 與病患關係 | 備註 |
| --- | --- | --- | --- | --- |
`;

export interface ConversationTurn {
  role: "user" | "assistant";
  /** Sender display name for user turns. */
  name?: string;
  text: string;
  at: string; // ISO timestamp
}

export interface BotContext {
  profile: string;
  members: string;
  /** Map of date → log markdown for the last few days. */
  recentLogs: Array<{ date: string; content: string }>;
  turns: ConversationTurn[];
  /** Recent turns from OTHER chats (group vs 1:1), for cross-chat awareness. */
  otherChats: Array<{ chatId: string; turns: ConversationTurn[] }>;
  /** Family-customizable standing instructions (prompts/custom.md). */
  instructions: string;
}

export async function loadContext(chatId: string, recentDays = 7): Promise<BotContext> {
  const dates: string[] = [];
  const now = Date.now();
  for (let i = 0; i < recentDays; i++) {
    dates.push(localDateTime(new Date(now - i * 86400_000)).date);
  }

  const [profile, members, convo, otherChatFiles, instructions, ...logs] = await Promise.all([
    readFile(PATHS.profile),
    readFile(PATHS.members),
    readFile(PATHS.conversation(chatId)),
    listDir(".state/conversations"),
    readFile(PATHS.instructions),
    ...dates.map((d) => readFile(PATHS.log(d))),
  ]);

  const otherIds = otherChatFiles
    .filter((n) => n.endsWith(".json") && n !== `${chatId}.json`)
    .map((n) => n.replace(/\.json$/, ""))
    .slice(0, 5);
  const otherChats: Array<{ chatId: string; turns: ConversationTurn[] }> = [];
  await Promise.all(
    otherIds.map(async (id) => {
      const f = await readFile(PATHS.conversation(id));
      if (!f) return;
      try {
        const turns = (JSON.parse(f.content) as ConversationTurn[]).slice(-8);
        if (turns.length > 0) otherChats.push({ chatId: id, turns });
      } catch {
        /* ignore corrupt state */
      }
    })
  );

  const recentLogs: Array<{ date: string; content: string }> = [];
  logs.forEach((f, i) => {
    const date = dates[i];
    if (f && date) recentLogs.push({ date, content: f.content });
  });

  let turns: ConversationTurn[] = [];
  if (convo) {
    try {
      turns = JSON.parse(convo.content) as ConversationTurn[];
    } catch {
      turns = [];
    }
  }

  return {
    profile: profile?.content ?? PROFILE_TEMPLATE,
    members: members?.content ?? MEMBERS_TEMPLATE,
    recentLogs,
    turns,
    otherChats,
    instructions: instructions?.content ?? "",
  };
}

export async function writeInstructions(content: string): Promise<void> {
  await writeFile(PATHS.instructions, content, "prompts: 更新家屬自訂指示");
}

export async function saveConversation(
  chatId: string,
  turns: ConversationTurn[],
  keep = 30
): Promise<void> {
  const trimmed = turns.slice(-keep);
  await writeFile(
    PATHS.conversation(chatId),
    JSON.stringify(trimmed, null, 2),
    "chore: update conversation state"
  );
}

/** Append a markdown entry to the daily log file, creating it if needed. */
export async function appendLogEntry(date: string, entryMarkdown: string): Promise<string> {
  const path = PATHS.log(date);
  const existing = await readFile(path);
  const header = `# ${date} 照護日誌\n`;
  const base = existing?.content ?? header;
  const next = base.trimEnd() + "\n\n" + entryMarkdown.trim() + "\n";
  await writeFile(path, next, `log: ${date} 新增紀錄`);
  return path;
}

export async function writeProfile(content: string): Promise<void> {
  await writeFile(PATHS.profile, content, "patient: 更新基本資料");
}

export async function writeMembers(content: string): Promise<void> {
  await writeFile(PATHS.members, content, "members: 更新家屬成員");
}

/** Save binary attachment; returns the repo-relative path for markdown links. */
export async function saveAttachment(
  bytes: Buffer,
  contentType: string,
  kind: "photo" | "audio"
): Promise<string> {
  const { date, time } = localDateTime();
  const ext = extFor(contentType, kind);
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${PATHS.attachmentDir}/${date}-${time.replace(":", "")}-${kind}-${rand}.${ext}`;
  await writeFile(path, bytes, `attachment: ${kind} ${date} ${time}`);
  return path;
}

function extFor(contentType: string, kind: "photo" | "audio"): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/x-m4a": "m4a",
    "audio/aac": "m4a",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
  };
  return map[contentType.split(";")[0]?.trim() ?? ""] ?? (kind === "photo" ? "jpg" : "m4a");
}

/**
 * Overwrite a markdown file under logs/ or patient/ (for the agent's
 * edit_file tool — corrections, deduping, restructuring). Returns an error
 * string when the path is not allowed, null on success.
 */
export async function editDataFile(
  path: string,
  content: string,
  reason: string
): Promise<string | null> {
  const clean = path.replace(/^\/+/, "");
  if (clean.includes("..") || !clean.endsWith(".md")) return "路徑不允許";
  if (!clean.startsWith("logs/") && !clean.startsWith("patient/") && !clean.startsWith("prompts/")) {
    return "只能編輯 logs/、patient/ 或 prompts/ 底下的 .md 檔案";
  }
  await writeFile(clean, content, `edit: ${clean} — ${reason}`.slice(0, 100));
  return null;
}

/** Read any file under the data root (for the agent's read_file tool). */
export async function readDataFile(path: string): Promise<string | null> {
  const clean = path.replace(/^\/+/, "");
  if (clean.includes("..")) return null;
  const allowed = ["patient/", "logs/", "attachments/", "prompts/", "schedule/"];
  if (!allowed.some((p) => clean.startsWith(p))) return null;
  const f = await readFile(clean);
  return f?.content ?? null;
}

export async function listLogFiles(): Promise<string[]> {
  const names = await listDir(PATHS.logDir);
  return names.filter((n) => n.endsWith(".md")).sort();
}
