import { invoke, isTauri } from "@tauri-apps/api/core";

export type SoftwareUpdatePhase = "idle" | "checking" | "downloading" | "verifying" | "saving" | "installing" | "error";
export interface SoftwareUpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  available: boolean;
  configured: boolean;
  phase?: SoftwareUpdatePhase;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  message?: string;
  error?: string;
  releaseNotes?: string;
}
export interface SoftwareUpdateAction { message?: string; }
type UpdateCommand = "check_software_update" | "get_software_update_status" | "open_software_update";

export function updateInvoke<T>(command: UpdateCommand): Promise<T> {
  if (isTauri()) return invoke<T>(command, {});
  if (window.drawStudioHost) return window.drawStudioHost.invoke(command, {}) as Promise<T>;
  return Promise.reject(new Error("请从桌面版使用软件更新。"));
}
export function updateIsActive(status: SoftwareUpdateStatus | null) {
  return !!status?.phase && ["checking", "downloading", "verifying", "saving", "installing"].includes(status.phase);
}
export const softwareUpdateOpenEvent = "draw-studio:open-software-update";
export function openSoftwareUpdate() { window.dispatchEvent(new Event(softwareUpdateOpenEvent)); }
