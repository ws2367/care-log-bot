import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

const API = "https://api.line.me/v2/bot";
const DATA_API = "https://api-data.line.me/v2/bot";

export function verifySignature(rawBody: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", config.lineChannelSecret)
    .update(rawBody)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function lineFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.lineChannelAccessToken}`,
      ...(init.headers || {}),
    },
  });
  return res;
}

export async function replyMessage(replyToken: string, texts: string[]): Promise<boolean> {
  const res = await lineFetch(`${API}/message/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      replyToken,
      messages: texts.slice(0, 5).map((text) => ({ type: "text", text: text.slice(0, 5000) })),
    }),
  });
  return res.ok;
}

export async function pushMessage(to: string, texts: string[]): Promise<boolean> {
  const res = await lineFetch(`${API}/message/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      messages: texts.slice(0, 5).map((text) => ({ type: "text", text: text.slice(0, 5000) })),
    }),
  });
  return res.ok;
}

/** Reply if the token is still valid, otherwise push to the chat. */
export async function respond(replyToken: string, chatId: string, texts: string[]): Promise<void> {
  if (texts.length === 0) return;
  const ok = await replyMessage(replyToken, texts);
  if (!ok) await pushMessage(chatId, texts);
}

/** Download image/audio/video content of a message. */
export async function getMessageContent(
  messageId: string
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await lineFetch(`${DATA_API}/message/${messageId}/content`);
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}

/** Display name of the sender, works for 1:1, group, and room chats. */
export async function getSenderName(source: {
  type: string;
  userId?: string;
  groupId?: string;
  roomId?: string;
}): Promise<string> {
  const { userId } = source;
  if (!userId) return "unknown";
  let url = `${API}/profile/${userId}`;
  if (source.type === "group" && source.groupId) {
    url = `${API}/group/${source.groupId}/member/${userId}`;
  } else if (source.type === "room" && source.roomId) {
    url = `${API}/room/${source.roomId}/member/${userId}`;
  }
  const res = await lineFetch(url);
  if (!res.ok) return "unknown";
  const data = (await res.json()) as { displayName?: string };
  return data.displayName || "unknown";
}
