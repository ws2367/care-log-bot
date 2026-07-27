import { config } from "./config.js";

/**
 * Transcribe an audio buffer. Provider preference:
 *   1. OpenAI  (OPENAI_API_KEY; model OPENAI_TRANSCRIBE_MODEL, default gpt-4o-mini-transcribe)
 *   2. Groq    (GROQ_API_KEY; whisper-large-v3)
 * Returns null when neither provider is configured.
 */
export async function transcribeAudio(
  bytes: Buffer,
  contentType: string
): Promise<string | null> {
  if (config.openaiApiKey) {
    return transcribeVia(
      "https://api.openai.com/v1/audio/transcriptions",
      config.openaiApiKey,
      config.openaiTranscribeModel,
      bytes,
      contentType
    );
  }
  if (config.groqApiKey) {
    return transcribeVia(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      config.groqApiKey,
      "whisper-large-v3",
      bytes,
      contentType
    );
  }
  return null;
}

async function transcribeVia(
  url: string,
  apiKey: string,
  model: string,
  bytes: Buffer,
  contentType: string
): Promise<string> {
  const form = new FormData();
  const ext = contentType.includes("mp") ? "mp3" : "m4a";
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: contentType }),
    `voice.${ext}`
  );
  form.append("model", model);
  form.append("response_format", "text");

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Transcription (${model}) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.text()).trim();
}
