import { readFile, writeFile } from "./github.js";
import { localDateTime } from "./config.js";

// ── Data model ───────────────────────────────────────────────────────────────
//
// schedule/routines.json  — routine DEFINITIONS (family-adjustable via chat)
// .state/schedule/D.json  — the day's PLAN instance (statuses, actual times)
// schedule/D.md           — generated human-readable checklist for Obsidian

export interface ChainRoutine {
  id: string;
  name: string;
  kind: "chain";
  /** Planned times "HH:MM", sorted. Encodes the interval pattern explicitly. */
  times: string[];
  /** Optional rotation labels cycled across the day's events (e.g. 左/中/右). */
  cycle?: string[];
  detail?: string;
}

export interface RiderRoutine {
  id: string;
  name: string;
  kind: "rider";
  /** Chain routine this rides on. */
  parent: string;
  /** Indices of parent events it attaches to; omitted = every event. */
  onEvents?: number[];
  detail?: string;
}

export type Routine = ChainRoutine | RiderRoutine;

export interface RoutineConfig {
  timezone?: string;
  routines: Routine[];
}

export interface PlanEvent {
  eid: string; // `${routineId}-${index+1}`
  routine: string;
  name: string;
  /** Minutes since local midnight (may exceed 1440 after big delays). */
  planned: number;
  side?: string;
  riders: string[];
  status: "pending" | "done" | "skipped";
  actual?: string; // "HH:MM" as reported
  note?: string;
}

export interface DayPlan {
  date: string;
  events: PlanEvent[];
}

export const DEFAULT_ROUTINES: RoutineConfig = {
  timezone: "Asia/Taipei",
  routines: [
    {
      id: "feeding",
      name: "餵食",
      kind: "chain",
      times: ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"],
      detail: "每三小時餵食一次，一日六次；每次依醫囑給水（各次水量請家屬用對話設定）",
    },
    {
      id: "meds",
      name: "吃藥",
      kind: "rider",
      parent: "feeding",
      onEvents: [0, 2, 4, 5],
      detail: "早、中、晚、睡前共四次，隨餵食服用",
    },
    {
      id: "turning",
      name: "翻身",
      kind: "chain",
      times: [
        "00:00", "03:00", "06:00", "08:00", "10:00", "12:00",
        "14:00", "16:00", "18:00", "20:00", "22:00",
      ],
      cycle: ["左", "中", "右"],
      detail: "白天每兩小時、凌晨 00:00–06:00 每三小時；姿勢依序左、中、右輪替",
    },
    { id: "diaper", name: "大小便檢查", kind: "rider", parent: "turning", detail: "每次翻身時檢查尿布" },
    { id: "percussion", name: "拍痰", kind: "rider", parent: "turning", detail: "每次翻身時拍上側背的痰" },
    {
      id: "bath",
      name: "清潔擦澡",
      kind: "chain",
      times: ["10:30"],
      detail: "每日一次：擦洗身體、換上衣、擦乳液、口腔清潔（漱口水）、護唇膏",
    },
    { id: "suction", name: "抽痰", kind: "chain", times: ["07:00", "19:00"], detail: "早晚各抽痰一次" },
    {
      id: "rehab",
      name: "復健",
      kind: "chain",
      times: ["08:30", "13:30", "19:30"],
      detail: "每次依序：腳踝、膝蓋、髖關節、手、肩膀",
    },
  ],
};

// ── Paths ────────────────────────────────────────────────────────────────────

const ROUTINES_PATH = "schedule/routines.json";
const planStatePath = (date: string) => `.state/schedule/${date}.json`;
const planViewPath = (date: string) => `schedule/${date}.md`;

// ── Time helpers ─────────────────────────────────────────────────────────────

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function fromMinutes(min: number): string {
  const dayOffset = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  const t = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return dayOffset > 0 ? `${t}(隔日)` : t;
}

// ── Config load / save ───────────────────────────────────────────────────────

export async function loadRoutines(): Promise<RoutineConfig> {
  const f = await readFile(ROUTINES_PATH);
  if (!f) return DEFAULT_ROUTINES;
  try {
    const parsed = JSON.parse(f.content) as RoutineConfig;
    if (!Array.isArray(parsed.routines)) return DEFAULT_ROUTINES;
    return parsed;
  } catch {
    return DEFAULT_ROUTINES;
  }
}

/** Validate + persist a new routines config. Returns error text or null. */
export async function saveRoutines(json: string): Promise<string | null> {
  let parsed: RoutineConfig;
  try {
    parsed = JSON.parse(json) as RoutineConfig;
  } catch (e) {
    return `JSON 格式錯誤：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!Array.isArray(parsed.routines) || parsed.routines.length === 0) {
    return "routines 必須是非空陣列";
  }
  const chainIds = new Set(parsed.routines.filter((r) => r.kind === "chain").map((r) => r.id));
  for (const r of parsed.routines) {
    if (!r.id || !r.name || !r.kind) return `routine 缺少 id/name/kind：${JSON.stringify(r)}`;
    if (r.kind === "chain") {
      if (!Array.isArray(r.times) || r.times.length === 0) return `${r.id} 缺少 times`;
      for (const t of r.times) {
        if (!/^\d{1,2}:\d{2}$/.test(t)) return `${r.id} 的時間格式錯誤：${t}（需 HH:MM）`;
      }
    } else if (r.kind === "rider") {
      if (!chainIds.has(r.parent)) return `${r.id} 的 parent「${r.parent}」不存在或不是 chain`;
    } else {
      return `未知的 kind：${(r as Routine).kind}`;
    }
  }
  await writeFile(ROUTINES_PATH, JSON.stringify(parsed, null, 2), "schedule: 更新例行行程設定");
  return null;
}

// ── Plan generation ──────────────────────────────────────────────────────────

export function generatePlan(config: RoutineConfig, date: string): DayPlan {
  const events: PlanEvent[] = [];
  const chains = config.routines.filter((r): r is ChainRoutine => r.kind === "chain");
  const riders = config.routines.filter((r): r is RiderRoutine => r.kind === "rider");

  for (const chain of chains) {
    const sorted = [...chain.times].sort((a, b) => toMinutes(a) - toMinutes(b));
    sorted.forEach((t, i) => {
      const myRiders = riders
        .filter((r) => r.parent === chain.id && (!r.onEvents || r.onEvents.includes(i)))
        .map((r) => r.name);
      events.push({
        eid: `${chain.id}-${i + 1}`,
        routine: chain.id,
        name: chain.name,
        planned: toMinutes(t),
        side: chain.cycle ? chain.cycle[i % chain.cycle.length] : undefined,
        riders: myRiders,
        status: "pending",
      });
    });
  }
  events.sort((a, b) => a.planned - b.planned || a.eid.localeCompare(b.eid));
  return { date, events };
}

// ── Plan load / save ─────────────────────────────────────────────────────────

export async function loadPlan(date: string): Promise<DayPlan> {
  const f = await readFile(planStatePath(date));
  if (f) {
    try {
      return JSON.parse(f.content) as DayPlan;
    } catch {
      /* regenerate below */
    }
  }
  const plan = generatePlan(await loadRoutines(), date);
  await savePlan(plan, "schedule: 產生今日行程");
  return plan;
}

export async function savePlan(plan: DayPlan, message: string): Promise<void> {
  await writeFile(planStatePath(plan.date), JSON.stringify(plan, null, 2), message);
  await writeFile(planViewPath(plan.date), renderPlanMarkdown(plan), message);
}

// ── Mutations ────────────────────────────────────────────────────────────────

export interface MutationResult {
  ok: boolean;
  message: string;
  plan?: DayPlan;
}

/** Mark an event done/skipped (records actual time; no cascade). */
export async function recordEvent(
  date: string,
  eid: string,
  status: "done" | "skipped",
  actual?: string,
  note?: string
): Promise<MutationResult> {
  const plan = await loadPlan(date);
  const ev = plan.events.find((e) => e.eid === eid);
  if (!ev) return { ok: false, message: `找不到行程 ${eid}（用 get_schedule 查看正確的 eid）` };
  ev.status = status;
  if (actual) ev.actual = actual;
  if (note) ev.note = note;
  await savePlan(plan, `schedule: ${ev.name} ${eid} ${status === "done" ? "完成" : "略過"}`);
  return { ok: true, message: `已更新 ${planViewPath(date)}`, plan };
}

/**
 * Delay one event to a new time; all LATER same-chain events that day shift by
 * the same delta, preserving the spacing between events. Riders follow their
 * parent automatically (they're attached to the event).
 */
export async function delayEvent(
  date: string,
  eid: string,
  newTime: string,
  note?: string,
  cascade = true
): Promise<MutationResult> {
  if (!/^\d{1,2}:\d{2}$/.test(newTime)) {
    return { ok: false, message: `時間格式錯誤：${newTime}（需 HH:MM）` };
  }
  const plan = await loadPlan(date);
  const ev = plan.events.find((e) => e.eid === eid);
  if (!ev) return { ok: false, message: `找不到行程 ${eid}（用 get_schedule 查看正確的 eid）` };

  const delta = toMinutes(newTime) - (ev.planned % 1440);
  const shifted: string[] = [];
  for (const e of plan.events) {
    if (e.routine !== ev.routine || e.status !== "pending") continue;
    if (!cascade && e.eid !== ev.eid) continue;
    if (e.planned < ev.planned || (e.planned === ev.planned && e.eid !== ev.eid)) continue;
    e.planned += delta;
    shifted.push(`${e.name}${e.side ? `(${e.side})` : ""} → ${fromMinutes(e.planned)}`);
  }
  if (note) ev.note = note;
  plan.events.sort((a, b) => a.planned - b.planned || a.eid.localeCompare(b.eid));
  await savePlan(
    plan,
    cascade
      ? `schedule: ${ev.name} 延至 ${newTime}，後續同鏈行程順延 ${delta > 0 ? "+" : ""}${delta} 分鐘`
      : `schedule: ${ev.name} ${eid} 單次改至 ${newTime}`
  );
  return {
    ok: true,
    message: `已更新 ${planViewPath(date)}\n${cascade ? "連動調整" : "單次改期"}：${shifted.join("、")}`,
    plan,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderPlanMarkdown(plan: DayPlan): string {
  const lines = [`# ${plan.date} 照護行程`, ""];
  for (const e of plan.events) {
    const box = e.status === "done" ? "x" : " ";
    const skip = e.status === "skipped" ? "（略過）" : "";
    const side = e.side ? `（${e.side}）` : "";
    const riders = e.riders.length > 0 ? `＋${e.riders.join("＋")}` : "";
    const actual = e.actual ? ` ✅ ${e.actual}` : "";
    const note = e.note ? ` — ${e.note}` : "";
    lines.push(`- [${box}] ${fromMinutes(e.planned)} ${e.name}${side}${riders}${skip}${actual}${note}`);
  }
  lines.push("", "> 由小安自動維護；完成、延遲、調整請在 LINE 跟小安說。");
  return lines.join("\n") + "\n";
}

/** Compact text view for the agent (includes eids). */
export function renderPlanForAgent(plan: DayPlan, nowMinutes: number): string {
  const lines = [`日期：${plan.date}（現在 ${fromMinutes(nowMinutes)}）`];
  for (const e of plan.events) {
    const side = e.side ? `（${e.side}）` : "";
    const riders = e.riders.length > 0 ? ` ＋${e.riders.join("＋")}` : "";
    const st =
      e.status === "done"
        ? `已完成${e.actual ? ` ${e.actual}` : ""}`
        : e.status === "skipped"
          ? "已略過"
          : e.planned < nowMinutes
            ? "逾時未回報"
            : "待辦";
    const note = e.note ? `｜${e.note}` : "";
    lines.push(`[${e.eid}] ${fromMinutes(e.planned)} ${e.name}${side}${riders}｜${st}${note}`);
  }
  return lines.join("\n");
}

/** Current local time as minutes since midnight. */
export function nowMinutes(): number {
  return toMinutes(localDateTime().time);
}
