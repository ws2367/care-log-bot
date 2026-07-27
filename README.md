# 小安（Xiǎo-Ān）— LINE 照護日誌機器人 / care-log

A LINE bot that lets a patient's family members log everything about the patient's
treatment and recovery — by simply sending **text, photos, or voice messages** in a
LINE chat (1:1 or group). An LLM agent structures every message into markdown care-log
files, asks clarifying questions when key details are missing, knows each family
member's relationship to the patient, and answers questions about the patient's history.

- Bot persona: **小安** — warm, concise, defaults to Traditional Chinese (臺灣用語),
  but replies in whatever language the family member uses.
- Data lives as **markdown files in a private GitHub repo** you own — viewable
  anywhere, and syncable into an **Obsidian vault** (including iCloud vaults) via the
  Obsidian Git plugin.

## Architecture

```
LINE (text / photo / voice, 1:1 or group)
        │  webhook
        ▼
Vercel Function (Hono, TypeScript)
        │
        ├─ Groq Whisper ── voice → transcript          (optional)
        ├─ OpenRouter ──── LLM agent with tools        (vision + tool calling)
        │                   log_entry / update_profile / update_members
        │                   read_file / list_logs
        ▼
GitHub repo (your "care-log" data repo)
   patient/profile.md         ← patient basics, meds, allergies…
   patient/members.md         ← family members: LINE ID → name, relationship
   logs/YYYY-MM-DD.md         ← one file per day, structured entries
   attachments/…              ← photos & voice files, linked from logs
   .state/…                   ← bot conversation memory (hidden in Obsidian)
        │
        ▼
Obsidian Git plugin → your Obsidian vault (iCloud) / any git client / GitHub web UI
```

Every log entry looks like:

```markdown
## 14:30｜生命徵象｜午後血壓量測
- 記錄者：大女兒 美玲

血壓 128/82 mmHg，心跳 76 bpm。飯後一小時量測，狀態平穩。
- 附件：![[attachments/2026-07-26-1430-photo-ab12cd.jpg]]
```

## Setup (~20 minutes)

### 1. Create the data repo

1. On GitHub, create a **private** repo, e.g. `care-log`. Add any file (e.g. README) so
   the default branch exists.
2. Create a **fine-grained personal access token**: GitHub → Settings → Developer
   settings → Fine-grained tokens → scope it to *only* this repo, permission
   **Contents: Read and write**. Save it for step 4.

### 2. Create the LINE bot

1. Go to [LINE Developers Console](https://developers.line.biz/console/) → create a
   **Provider** → create a **Messaging API channel** (this also creates a LINE Official
   Account).
2. In the channel's **Messaging API** tab:
   - Issue a **Channel access token (long-lived)**.
   - Note the **Channel secret** (Basic settings tab).
3. In [LINE Official Account Manager](https://manager.line.biz/) → Settings →
   Response settings:
   - **Disable** auto-reply messages and greeting messages (the bot handles these).
   - Ensure **Webhooks** are enabled.
4. To use the bot in **group chats**: LINE Developers Console → Messaging API →
   "Allow bot to join group chats" → **Enable**.

### 3. Get API keys

- **OpenRouter**: [openrouter.ai/keys](https://openrouter.ai/keys). Default model is
  `anthropic/claude-sonnet-4.5`; set `OPENROUTER_MODEL` to any model that supports
  **both vision and tool calling** ([model list](https://openrouter.ai/models)).
- **Groq** (optional, for voice messages): [console.groq.com](https://console.groq.com)
  — free tier includes Whisper transcription. Skip it and the bot will ask users to
  type instead.

### 4. Deploy to Vercel

```bash
npm install -g vercel@latest   # your local CLI (55.x) is outdated; 57+ recommended
cd care-log
npm install
vercel link                    # create/link a Vercel project
```

Add the environment variables (repeat for each var, or use the Vercel dashboard —
values from `.env.example`):

```bash
vercel env add LINE_CHANNEL_SECRET production
vercel env add LINE_CHANNEL_ACCESS_TOKEN production
vercel env add OPENROUTER_API_KEY production
vercel env add GITHUB_TOKEN production
vercel env add GITHUB_REPO production        # e.g. your-username/care-log
vercel env add GROQ_API_KEY production       # optional
```

Optional vars: `OPENROUTER_MODEL`, `GITHUB_BRANCH` (default `main`), `DATA_ROOT`
(subfolder inside the repo), `TIMEZONE` (default `Asia/Taipei`).

Deploy:

```bash
vercel deploy --prod
```

### 5. Wire up the webhook

In LINE Developers Console → Messaging API tab:

- **Webhook URL**: `https://<your-project>.vercel.app/api/webhook`
- Click **Verify** (should succeed), then enable **Use webhook**.

### 6. Try it

Add the bot as a friend (QR code in the console), or invite it into a family group
chat. Send: 「爸爸今天中午吃了半碗稀飯，胃口不太好」— you should see
`logs/<today>.md` appear in the data repo within seconds.

### 7. Sync into Obsidian (iCloud vault)

Install the community plugin **Git** (obsidian-git) in Obsidian, then either:

- **Option A (recommended)** — clone `care-log` as its own vault folder and open it in
  Obsidian; enable auto-pull in the Git plugin, or
- **Option B** — make the data repo a subfolder of your existing iCloud vault: clone
  `care-log` inside the vault, and Obsidian Git will pull new entries in.

Photos embed automatically via `![[attachments/…]]` links. The `.state/` folder is
hidden by Obsidian (dot-folder) — it's the bot's conversation memory; don't edit it.

> **Alternative sync targets**: since the source of truth is a git repo, you can also
> mirror it to Dropbox/Google Drive with a scheduled `git pull` on any machine, or just
> read it on GitHub's web/mobile UI. Direct iCloud Drive writes from a cloud host
> aren't practical — the git-based flow is the reliable path.

## What the bot does

| You send | Bot does |
| --- | --- |
| 「下午三點吃了普拿疼500mg」 | Logs it under 用藥 with time + dose; confirms in one line |
| Photo of a meal / wound / lab report / med bag | Reads the image, extracts values & text, logs with the photo attached |
| Voice message | Transcribes (Groq Whisper), then logs as above |
| 「我是他的二兒子」 | Records you in `patient/members.md`; uses your role when logging |
| 「這週血壓怎麼樣？」 | Answers from the logs, citing dates/values; digs into older logs when needed |
| Incomplete info (e.g. 「吃過藥了」) | Logs what's known, asks ≤2 short follow-up questions (which药? 何時?) |
| Group small-talk unrelated to care | Stays silent |

## Safety & privacy notes

- The bot never diagnoses or suggests medication changes; it reminds users to call 119
  / seek care on red-flag symptoms.
- All data flows: LINE → Vercel → OpenRouter (LLM) + Groq (voice) + GitHub. Use
  providers you're comfortable with for medical data; OpenRouter lets you pick models /
  providers with no-retention policies.
- Keep the data repo **private**; scope the GitHub token to only that repo.

## Development

```bash
npm install
npm run typecheck
vercel dev        # local server; use ngrok etc. to test the webhook end-to-end
```

Key files:

- [api/index.ts](api/index.ts) — webhook endpoint (signature check, async processing)
- [src/handler.ts](src/handler.ts) — per-event orchestration (download media, transcribe, run agent, reply)
- [src/agent.ts](src/agent.ts) — OpenRouter tool-calling loop + tool implementations
- [src/prompts.ts](src/prompts.ts) — 小安's persona & policies (edit to tune behavior)
- [src/store.ts](src/store.ts) — markdown/data layout in the GitHub repo
- [src/line.ts](src/line.ts), [src/github.ts](src/github.ts), [src/transcribe.ts](src/transcribe.ts) — API clients
