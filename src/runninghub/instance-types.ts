import type { RunningHubInstanceType } from "../types";

export const runningHubInstanceTypes: readonly { value: RunningHubInstanceType; label: string }[] = [
  { value: "default", label: "Standard" },
  { value: "plus", label: "Plus" },
  { value: "ultra", label: "6000D" },
];

/** Only absent legacy values use the default; unknown selections never downgrade. */
export function normalizeRunningHubInstanceType(value: unknown): RunningHubInstanceType {
  if (value === undefined) return "default";
  if (runningHubInstanceTypes.some(option => option.value === value)) return value as RunningHubInstanceType;
  throw new Error("RunningHub 运行模式无效，请选择 Standard、Plus 或 6000D。");
}

/** Corrupt saved history must remain readable without weakening execution checks. */
export function runningHubInstanceTypeLabel(value?: RunningHubInstanceType): string {
  if (value === undefined) return runningHubInstanceTypes[0].label;
  return runningHubInstanceTypes.find(option => option.value === value)?.label ?? "未知模式";
}
