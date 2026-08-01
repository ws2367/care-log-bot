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
  /** Family's standing instructions (prompts/custom.md) the agent must follow. */
  customInstructions?: string;
}

export type ReviewVerdict = "approve" | "revise" | "reject";

export interface ReviewResult {
  verdict: ReviewVerdict;
  /** For approve/revise: the text to send. For reject: the (unsendable) draft. */
  finalReply: string;
  /** For reject: what the agent must fix — fed back into the agent loop. */
  feedback?: string;
  reason?: string;
}

const REVIEWER_SYSTEM = `你是照護日誌機器人「小安」的獨立審核員。小安即將把一則回覆傳給病患家屬；你要在送出前把關。你只看得到本回合的事實，沒有先前對話的包袱——這是刻意設計，讓你能客觀查核。

依序檢查草稿回覆：

1. **言行一致（最重要，雙向檢查）**：
   （a）說到要做到——回覆中宣稱或承諾的每一個動作（已記錄／已更新／已刪除／會記錄），都必須有「本回合實際寫入的檔案」與〈檔案實際內容〉佐證。承諾「稍後記錄」也不可接受——該做的必須在本回合完成。
   （b）做了要說清楚——本回合實際寫入的變更，回覆必須如實反映，不能隱瞞、也不能描述成別的內容。
   （c）家屬明確要求的動作（記錄、修改、刪除、補記）必須確實完成，不能只用文字應付。
2. **檔案為準**：回答「有沒有記錄」這類問題時，答案必須與〈檔案實際內容〉完全一致——不能多列不存在的紀錄，也不能漏掉存在的。
3. **數據正確**：回覆中的數值（血壓、劑量、時間等）必須出自家屬訊息或檔案內容，不能捏造或抄錯。
4. **遵守指示**：回覆必須符合〈家屬自訂指示〉（若有）。
5. **純文字**：LINE 不支援 markdown。移除 **粗體**、# 標題、表格符號；條列用 - 或 •。
6. **醫療界線**：不診斷、不建議更改處方；危急徵兆（意識不清、呼吸困難、大量出血、胸痛等）應提醒就醫或撥打 119。
7. **語言與語氣**：與家屬使用的語言一致（預設繁體中文台灣用語），簡潔溫暖。

裁決規則——只輸出一個 JSON 物件，不加任何其他文字：
- 草稿沒問題：{"verdict":"approve"}
- 只有文字問題（格式、語氣、措辭、數字抄錯但檔案是對的）：{"verdict":"revise","reply":"修正後的完整回覆","reason":"一句話說明修了什麼"}
- 需要小安重做（該寫入的沒寫入、家屬要求的動作沒完成、檔案內容需要用工具修正）：{"verdict":"reject","feedback":"具體告訴小安缺了什麼、該補做什麼動作"}

分辨 revise 與 reject 的準則：文字改一改就能讓回覆變誠實且完整 → revise；問題出在「動作沒做」，光改文字只是把謊話改成道歉 → reject，讓小安真的去做。
reject 的 feedback 要具體可執行，例如：「家屬回報的鉀離子 2.7 與點滴醫囑尚未寫入今天的日誌，請用 log_entry 記錄後再回覆」。`;

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

〈家屬自訂指示〉：
${input.customInstructions?.trim() || "（無）"}

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
  if (!jsonMatch) return { verdict: "approve", finalReply: input.draft };

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      verdict?: string;
      reply?: string;
      feedback?: string;
      reason?: string;
    };
    if (parsed.verdict === "reject" && parsed.feedback?.trim()) {
      return {
        verdict: "reject",
        finalReply: input.draft,
        feedback: parsed.feedback.trim(),
        reason: parsed.reason,
      };
    }
    if (parsed.verdict === "revise" && parsed.reply?.trim()) {
      return { verdict: "revise", finalReply: parsed.reply.trim(), reason: parsed.reason };
    }
    return { verdict: "approve", finalReply: input.draft };
  } catch {
    return { verdict: "approve", finalReply: input.draft };
  }
}
