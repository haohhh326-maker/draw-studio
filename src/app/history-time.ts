export type HistoryTimeFilter = "all" | "day" | "three-days" | "week" | "month" | "older";

export const historyTimeOptions: { value: HistoryTimeFilter; label: string; title?: string }[] = [
  { value: "all", label: "全部" },
  { value: "day", label: "最近1天" },
  { value: "three-days", label: "最近3天" },
  { value: "week", label: "最近7天" },
  { value: "month", label: "最近一个月", title: "最近30天" },
  { value: "older", label: "一个月前", title: "超过30天的记录" },
];

const day = 24 * 60 * 60 * 1000;
const days = { day: 1, "three-days": 3, week: 7, month: 30 };

/** Rolling time windows include their lower boundary; older starts before it. */
export function filterHistoryByTime<T extends { createdAt: number }>(entries: readonly T[], filter: HistoryTimeFilter, now = Date.now()): T[] {
  if (filter === "all") return [...entries];
  return entries.filter(entry => {
    if (!Number.isFinite(entry.createdAt) || entry.createdAt > now) return false;
    return filter === "older" ? entry.createdAt < now - 30 * day : entry.createdAt >= now - days[filter] * day;
  });
}
