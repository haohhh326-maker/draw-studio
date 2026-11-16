import { describe, expect, it } from "vitest";
import { filterHistoryByTime, historyTimeOptions } from "../src/app/history-time";

const day = 86_400_000;
const now = Date.UTC(2026, 9, 2, 12);
const entries = [
  { id: "now", createdAt: now },
  { id: "day", createdAt: now - day },
  { id: "three", createdAt: now - 3 * day },
  { id: "week", createdAt: now - 7 * day },
  { id: "month", createdAt: now - 30 * day },
  { id: "older", createdAt: now - 30 * day - 1 },
  { id: "future", createdAt: now + 1 },
  { id: "invalid", createdAt: Number.NaN },
];
const ids = (filter: Parameters<typeof filterHistoryByTime>[1]) => filterHistoryByTime(entries, filter, now).map(entry => entry.id);

describe("history time filters", () => {
  it("keeps all records and does not mutate source order", () => {
    const all = filterHistoryByTime(entries, "all", now);
    expect(all).toEqual(entries); expect(all).not.toBe(entries);
    expect(entries.map(entry => entry.id)).toEqual(["now", "day", "three", "week", "month", "older", "future", "invalid"]);
  });
  it.each([
    ["day", ["now", "day"]],
    ["three-days", ["now", "day", "three"]],
    ["week", ["now", "day", "three", "week"]],
    ["month", ["now", "day", "three", "week", "month"]],
    ["older", ["older"]],
  ] as const)("uses inclusive boundaries for %s and excludes future or invalid timestamps", (filter, expected) => {
    expect(ids(filter)).toEqual(expected);
  });
  it("offers each supported filter once and a clear 30-day month tooltip", () => {
    expect(new Set(historyTimeOptions.map(option => option.value)).size).toBe(6);
    expect(historyTimeOptions.find(option => option.value === "month")?.title).toBe("最近30天");
  });
});
