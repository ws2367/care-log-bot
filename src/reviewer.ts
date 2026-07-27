import { chatOnce } from "./llm.js";
import { config } from "./config.js";

export interface ReviewInput {
  senderName: string;
  incomingText: string;
  /** Last few turns of this chat, compact text form (for tone/context only). */
  recentTurns: string;
  /** The main agent's draft reply. */
  draft: string;
  /** Files the agent actually wrote this turn. */
  wrote: string[];
  /** Ground truth: current post-write contents of the relevant data files. */
  files: Array<{ path: string; content: string }>;
}

export interface ReviewResult {
  finalReply: string;
  revised: boolean;
  reason?: string;
}

const REVIEWER_SYSTEM = `你是照護日誌機器人「小安」的獨立審核員。小安即將把一則回覆傳給病患家屬；你要在送出前把關。你只看得到本回合的事實，沒有先前對話的包袱——這是刻意設計，讓你能客觀查核。

依序檢查草稿回覆：

1. **誠實性（最重要）**：回覆中凡是宣稱「已記錄／已更新／已刪除／已寫入」的內容，必須能在下方〈檔案實際內容〉中找到對應文字，且「本回合實際寫入的檔案」清單要能支持這些宣稱。回答「有沒有記錄」這類問題時，答案必須與檔案實際內容完全一致——不能多列不存在的紀錄，也不能漏掉存在的。
2. **數據正確**：回覆中的數值（血壓、劑量、時間等）必須出自家屬訊息或檔案內容，不能捏造或抄錯。
3. **純文字**：LINE 不支援 markdown。移除 **粗體**、# 標題、表格符號；條列用 - 或 •。
4. **醫療界線**：不診斷、不建議更改處方；危急徵兆（意識不清、呼吸困難、大量出血、胸痛等）應提醒就醫或撥打 119。
5. **語言與語氣**：與家屬使用的語言一致（預設繁體中文台灣用語），簡潔溫暖。

輸出規則：只輸出一個 JSON 物件，不加任何其他文字。
- 草稿沒問題：{"verdict":"approve"}
- 需要修正：{"verdict":"revise","reply":"修正後的完整回覆（保留原意，只修正有問題的部分）","reason":"一句話說明修了什麼"}

修正時務必誠實：如果草稿宣稱已記錄但檔案裡沒有，改成如實告知（例如「這部分還沒寫入日誌，請再傳一次」），絕不能替它圓謊。`;

export async function reviewReply(input: ReviewInput): Promise<ReviewResult> {
  const filesBlock =
    input.files.length > 0
      ? input.files
          .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
          .join("\n\n")
      : "（本回合相關檔案皆不存在）";

  const userMsg = `〈家屬剛傳來的訊息〉（${input.senderName}）：
${input.incomingText}

〈近期對話（僅供理解語境）〉：
${input.recentTurns || "（無）"}

〈本回合實際寫入的檔案〉：${input.wrote.length > 0 ? input.wrote.join("、") : "（沒有任何寫入）"}

〈檔案實際內容（唯一事實來源）〉：
${filesBlock}

〈小安的草稿回覆〉：
${input.draft}`;

  const choice = await chatOnce(
    [
      { role: "system", content: REVIEWER_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { model: config.reviewerModel, maxTokens: 2048 }
  );

  const raw = (choice.message.content ?? "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { finalReply: input.draft, revised: false };

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      verdict?: string;
      reply?: string;
      reason?: string;
    };
    if (parsed.verdict === "revise" && parsed.reply && parsed.reply.trim()) {
      return { finalReply: parsed.reply.trim(), revised: true, reason: parsed.reason };
    }
    return { finalReply: input.draft, revised: false };
  } catch {
    return { finalReply: input.draft, revised: false };
  }
}
