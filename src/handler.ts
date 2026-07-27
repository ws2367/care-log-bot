import { runAgent, type IncomingMessage } from "./agent.js";
import { localDateTime } from "./config.js";
import { getMessageContent, getSenderName, respond } from "./line.js";
import { reviewReply } from "./reviewer.js";
import {
  loadContext,
  PATHS,
  readDataFile,
  saveAttachment,
  saveConversation,
  type ConversationTurn,
} from "./store.js";
import { transcribeAudio } from "./transcribe.js";

// LINE webhook event (the subset we use).
export interface LineEvent {
  type: string;
  replyToken?: string;
  deliveryContext?: { isRedelivery?: boolean };
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: {
    id: string;
    type: "text" | "image" | "audio" | "video" | "file" | "sticker" | "location";
    text?: string;
  };
}

function chatIdOf(source: LineEvent["source"]): string {
  return source.groupId ?? source.roomId ?? source.userId ?? "unknown";
}

const GREETING = [
  "大家好，我是照護日誌小幫手「小安」🌱",
  "把病患的大小事傳給我——文字、照片、語音都可以，我會整理成日誌。",
  "也可以隨時問我病患的狀況，例如「這週吃得怎麼樣？」",
  "第一次使用，請先告訴我：病患的基本資料，以及大家與病患的關係。",
].join("\n");

export async function handleEvent(event: LineEvent): Promise<void> {
  // Skip webhook redeliveries to avoid double-logging.
  if (event.deliveryContext?.isRedelivery) return;

  const chatId = chatIdOf(event.source);

  if (event.type === "join" || event.type === "follow") {
    if (event.replyToken) await respond(event.replyToken, chatId, [GREETING]);
    return;
  }

  if (event.type !== "message" || !event.message || !event.replyToken) return;
  const msg = event.message;

  const senderUserId = event.source.userId ?? "unknown";
  const [senderName, ctx] = await Promise.all([
    getSenderName(event.source),
    loadContext(chatId),
  ]);

  const incoming: IncomingMessage = {
    senderUserId,
    senderName,
    text: "",
  };
  let turnDescription = "";

  if (msg.type === "text") {
    incoming.text = msg.text ?? "";
    turnDescription = incoming.text;
  } else if (msg.type === "image") {
    const content = await getMessageContent(msg.id);
    if (!content) {
      await respond(event.replyToken, chatId, ["抱歉，照片下載失敗了，可以再傳一次嗎？🙏"]);
      return;
    }
    const repoPath = await saveAttachment(content.bytes, content.contentType, "photo");
    const mediaType = content.contentType.split(";")[0] || "image/jpeg";
    incoming.images = [
      {
        dataUrl: `data:${mediaType};base64,${content.bytes.toString("base64")}`,
        repoPath,
      },
    ];
    incoming.text = "（家屬傳來一張照片，請解讀內容並判斷是否記錄）";
    turnDescription = `（傳了一張照片：${repoPath}）`;
  } else if (msg.type === "audio") {
    const content = await getMessageContent(msg.id);
    if (!content) {
      await respond(event.replyToken, chatId, ["抱歉，語音下載失敗了，可以再傳一次嗎？🙏"]);
      return;
    }
    let transcript: string | null = null;
    try {
      transcript = await transcribeAudio(content.bytes, content.contentType);
    } catch (err) {
      console.error("transcription failed", err);
      await respond(event.replyToken, chatId, [
        "抱歉，語音轉文字暫時失敗了，麻煩改用文字傳一次 🙏",
      ]);
      return;
    }
    if (transcript === null) {
      await respond(event.replyToken, chatId, [
        "目前還沒開啟語音功能（管理員尚未設定轉錄服務），請先用文字或照片記錄喔 🙏",
      ]);
      return;
    }
    incoming.audioPath = await saveAttachment(content.bytes, content.contentType, "audio");
    incoming.text = transcript;
    turnDescription = `（語音）${transcript}`;
  } else {
    // Stickers, videos, files, locations — ignore silently in groups.
    return;
  }

  let reply: string | null = null;
  let wrote: string[] = [];
  try {
    const result = await runAgent(ctx, incoming);
    reply = result.reply;
    wrote = result.wrote;
  } catch (err) {
    console.error("agent failed", err);
    await respond(event.replyToken, chatId, [
      "抱歉，小安剛剛出了點狀況，這則訊息沒有記錄成功。請稍後再傳一次 🙏",
    ]);
    return;
  }

  // Pre-send review: an independent model call with a clean context window
  // checks the draft against the ACTUAL post-write file contents, so the bot
  // can never again claim "已記錄" for something that isn't in the files.
  // Fails open (sends the draft) so a reviewer outage can't block care messages.
  if (reply) {
    try {
      const today = localDateTime().date;
      const paths = [...new Set([PATHS.log(today), PATHS.profile, PATHS.members, ...wrote])];
      const files = (
        await Promise.all(
          paths.map(async (p) => ({ path: p, content: await readDataFile(p) }))
        )
      ).filter((f): f is { path: string; content: string } => f.content !== null);

      const recentTurns = ctx.turns
        .slice(-4)
        .map((t) => `${t.role === "user" ? t.name ?? "家屬" : "小安"}：${t.text.slice(0, 200)}`)
        .join("\n");

      const review = await reviewReply({
        senderName,
        incomingText: incoming.text,
        recentTurns,
        draft: reply,
        wrote,
        files,
      });
      if (review.revised) {
        console.log("reviewer revised reply:", review.reason);
        reply = review.finalReply;
      }
    } catch (err) {
      console.error("reviewer failed; sending unreviewed draft", err);
    }
  }

  // Persist the conversation turns (user + assistant) for follow-up context.
  // Assistant turns are annotated with the files actually written that turn,
  // so future runs can distinguish real writes from mere claims.
  const at = new Date().toISOString();
  const turns: ConversationTurn[] = [
    ...ctx.turns,
    { role: "user", name: senderName, text: turnDescription, at },
  ];
  if (reply) {
    const annotation =
      wrote.length > 0 ? `〔本回合已寫入：${[...new Set(wrote)].join("、")}〕` : "〔本回合未寫入檔案〕";
    turns.push({ role: "assistant", text: `${reply}\n${annotation}`, at });
  }
  try {
    await saveConversation(chatId, turns);
  } catch (err) {
    console.error("failed to save conversation state", err);
  }

  if (reply) await respond(event.replyToken, chatId, [reply]);
}
