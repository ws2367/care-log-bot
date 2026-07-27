function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  get lineChannelSecret() {
    return required("LINE_CHANNEL_SECRET");
  },
  get lineChannelAccessToken() {
    return required("LINE_CHANNEL_ACCESS_TOKEN");
  },
  get openrouterApiKey() {
    return required("OPENROUTER_API_KEY");
  },
  get openrouterModel() {
    return process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5";
  },
  /** Model for the pre-send reviewer; defaults to the main model. */
  get reviewerModel() {
    return process.env.OPENROUTER_REVIEWER_MODEL || this.openrouterModel;
  },
  get githubToken() {
    return required("GITHUB_TOKEN");
  },
  get githubRepo() {
    return required("GITHUB_REPO");
  },
  get githubBranch() {
    return process.env.GITHUB_BRANCH || "main";
  },
  /** Optional subdirectory inside the data repo; "" means repo root. */
  get dataRoot() {
    const root = (process.env.DATA_ROOT || "").replace(/^\/+|\/+$/g, "");
    return root;
  },
  get groqApiKey() {
    return process.env.GROQ_API_KEY || "";
  },
  get timezone() {
    return process.env.TIMEZONE || "Asia/Taipei";
  },
};

/** "2026-07-26" and "14:35" in the configured timezone. */
export function localDateTime(d = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}
