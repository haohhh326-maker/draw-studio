import { invoke, isTauri } from "@tauri-apps/api/core";
import { create } from "zustand";

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

export interface SoftwareUpdateView {
  status: SoftwareUpdateStatus | null;
  checking: boolean;
  pending: boolean;
  preparing: boolean;
  actionStarted: boolean;
  error: string;
  feedback: string;
}

export const useSoftwareUpdateView = create<SoftwareUpdateView>(() => ({
  status: null, checking: false, pending: false, preparing: false, actionStarted: false, error: "", feedback: "",
}));

let checkingRequest: Promise<SoftwareUpdateStatus | null> | undefined;
let readingRequest: Promise<SoftwareUpdateStatus> | undefined;
let actionRequest: Promise<void> | undefined;
let initialization: Promise<void> | undefined;
let revision = 0;

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}
type UpdateCommand = "check_software_update" | "get_software_update_status" | "open_software_update";

export function updateInvoke<T>(command: UpdateCommand): Promise<T> {
  if (isTauri()) return invoke<T>(command, {});
  if (window.drawStudioHost) return window.drawStudioHost.invoke(command, {}) as Promise<T>;
  return Promise.reject(new Error("请从桌面版使用软件更新。"));
}
export function updateIsActive(status: SoftwareUpdateStatus | null) {
  return !!status?.phase && ["checking", "downloading", "verifying", "saving", "installing"].includes(status.phase);
}

export function refreshSoftwareUpdateStatus() {
  const current = useSoftwareUpdateView.getState();
  if (current.preparing && current.status) return Promise.resolve(current.status);
  if (readingRequest) return readingRequest;
  const observedRevision = revision;
  readingRequest = updateInvoke<SoftwareUpdateStatus>("get_software_update_status").then(status => {
    if (observedRevision === revision) useSoftwareUpdateView.setState(previous => ({
      status,
      actionStarted: previous.actionStarted || ["downloading", "verifying", "saving", "installing"].includes(status.phase || "")
        || status.phase === "error" && status.available,
      error: previous.pending || updateIsActive(status) ? "" : previous.error,
    }));
    return status;
  }).catch(cause => {
    if (observedRevision === revision) useSoftwareUpdateView.setState({ error: errorMessage(cause, "无法读取更新进度，请重试。") });
    throw cause;
  }).finally(() => { readingRequest = undefined; });
  return readingRequest;
}

export function checkSoftwareUpdates() {
  if (checkingRequest) return checkingRequest;
  const current = useSoftwareUpdateView.getState();
  if (current.pending || updateIsActive(current.status)) return Promise.resolve(current.status);
  const observedRevision = ++revision;
  useSoftwareUpdateView.setState({ checking: true, error: "", feedback: "" });
  checkingRequest = updateInvoke<SoftwareUpdateStatus>("check_software_update").then(status => {
    if (observedRevision === revision) {
      ++revision;
      useSoftwareUpdateView.setState({ status, checking: false });
    }
    return status;
  }).catch(cause => {
    if (observedRevision === revision) {
      ++revision;
      useSoftwareUpdateView.setState({ checking: false, error: errorMessage(cause, "检查更新失败，请重试。") });
    }
    throw cause;
  }).finally(() => {
    checkingRequest = undefined;
  });
  return checkingRequest;
}

export function initializeSoftwareUpdates() {
  return initialization ??= (async () => {
    await refreshSoftwareUpdateStatus();
    const current = useSoftwareUpdateView.getState();
    if (!current.pending && !updateIsActive(current.status) && current.status?.phase !== "error" && !current.error) await checkSoftwareUpdates();
  })();
}

export function downloadSoftwareUpdate(saveBeforeUpdate: () => Promise<void>) {
  if (actionRequest) return actionRequest;
  const current = useSoftwareUpdateView.getState();
  if (current.pending || current.checking || updateIsActive(current.status)) return Promise.resolve();
  ++revision;
  useSoftwareUpdateView.setState(previous => ({
    pending: true, preparing: true, actionStarted: true, error: "", feedback: "",
    status: previous.status && { ...previous.status, phase: "idle", message: undefined, error: undefined },
  }));
  actionRequest = Promise.resolve().then(async () => {
    await saveBeforeUpdate();
    ++revision;
    useSoftwareUpdateView.setState({ preparing: false });
    const result = await updateInvoke<SoftwareUpdateAction | undefined>("open_software_update");
    ++revision;
    useSoftwareUpdateView.setState(previous => ({
      feedback: result?.message || "已启动新版安装程序。",
      status: previous.status && { ...previous.status, phase: "installing", message: "已启动新版安装程序。", error: undefined },
    }));
  }).catch(cause => {
    ++revision;
    const message = errorMessage(cause, "更新失败，请重试。");
    useSoftwareUpdateView.setState(previous => ({
      error: message,
      status: previous.status && { ...previous.status, phase: "error", message, error: message },
    }));
  }).finally(() => {
    actionRequest = undefined;
    useSoftwareUpdateView.setState({ pending: false, preparing: false });
  });
  return actionRequest;
}

const phaseLabels = { idle: "", checking: "正在检查更新…", downloading: "正在下载安装包…", verifying: "正在校验安装包…", saving: "正在保存项目，准备安装更新…", installing: "正在启动新版安装程序…", error: "软件更新未完成，请重试。" };
export function softwareUpdateMessage(view: SoftwareUpdateView, native = true) {
  if (!native) return "请从桌面版使用软件更新。";
  if (view.preparing) return "正在保存当前项目…";
  if (view.checking || view.status?.phase === "checking") return "正在检查更新…";
  if (view.error) return view.error;
  if (view.feedback) return view.feedback;
  if (view.pending && (!view.status?.phase || view.status.phase === "idle")) return "正在开始更新…";
  if (view.status && !view.status.configured) return "软件更新服务尚未启用，请稍后检查。";
  return view.status?.message || phaseLabels[view.status?.phase || "idle"]
    || (view.status?.available ? "有新版本可供下载。" : view.status ? "当前已是最新版本。" : "点击检查更新，获取最新版本。");
}

export const softwareUpdateOpenEvent = "draw-studio:open-software-update";
export function openSoftwareUpdate() { window.dispatchEvent(new Event(softwareUpdateOpenEvent)); }
