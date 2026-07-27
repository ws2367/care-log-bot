import { config } from "./config.js";

/**
 * Transcribe an audio buffer with Groq's hosted Whisper (free tier available).
 * Returns null when no GROQ_API_KEY is configured.
 */
export async function transcribeAudio(
  bytes: Buffer,
  contentType: string
): Promise<string | null> {
  if (!config.groqApiKey) return null;

  const form = new FormData();
  const ext = contentType.includes("mp") ? "mp3" : "m4a";
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: contentType }),
    `voice.${ext}`
  );
  form.append("model", "whisper-large-v3");
  form.append("response_format", "text");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Groq transcription failed: ${res.status} ${await res.text()}`);
  }
  return (await res.text()).trim();
}
