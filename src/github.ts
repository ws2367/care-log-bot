import { config } from "./config";

const API = "https://api.github.com";

function fullPath(path: string): string {
  const clean = path.replace(/^\/+/, "");
  return config.dataRoot ? `${config.dataRoot}/${clean}` : clean;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "medic-bot",
  };
}

function contentUrl(path: string): string {
  return `${API}/repos/${config.githubRepo}/contents/${fullPath(path)
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

export interface RepoFile {
  content: string;
  sha: string;
}

/** Read a text file. Returns null if it doesn't exist. */
export async function readFile(path: string): Promise<RepoFile | null> {
  const res = await fetch(`${contentUrl(path)}?ref=${config.githubBranch}`, {
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read ${path}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { content?: string; sha: string; encoding?: string };
  const content = data.content ? Buffer.from(data.content, "base64").toString("utf8") : "";
  return { content, sha: data.sha };
}

/** Create or update a text/binary file. Retries once on a sha conflict. */
export async function writeFile(
  path: string,
  content: string | Buffer,
  message: string
): Promise<void> {
  const attempt = async (): Promise<Response> => {
    const existing = await readFileSha(path);
    const body: Record<string, unknown> = {
      message,
      branch: config.githubBranch,
      content: Buffer.isBuffer(content)
        ? content.toString("base64")
        : Buffer.from(content, "utf8").toString("base64"),
    };
    if (existing) body.sha = existing;
    return fetch(contentUrl(path), {
      method: "PUT",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  let res = await attempt();
  if (res.status === 409 || res.status === 422) {
    // Concurrent write from another message — re-read sha and retry once.
    res = await attempt();
  }
  if (!res.ok) throw new Error(`GitHub write ${path}: ${res.status} ${await res.text()}`);
}

async function readFileSha(path: string): Promise<string | null> {
  const res = await fetch(`${contentUrl(path)}?ref=${config.githubBranch}`, {
    headers: headers(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub stat ${path}: ${res.status}`);
  const data = (await res.json()) as { sha: string };
  return data.sha;
}

/** List names of files in a directory (non-recursive). Empty array if missing. */
export async function listDir(path: string): Promise<string[]> {
  const res = await fetch(`${contentUrl(path)}?ref=${config.githubBranch}`, {
    headers: headers(),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list ${path}: ${res.status}`);
  const data = (await res.json()) as Array<{ name: string; type: string }>;
  return data.filter((e) => e.type === "file").map((e) => e.name);
}
