import { invoke, isTauri } from "@tauri-apps/api/core";
import type { CanvasService } from "./NativeCanvasServicePanel";

type ServiceCommand = "show_service_webview" | "set_service_webview_bounds" | "hide_service_webview"
  | "reload_service_webview" | "set_service_webview_zoom"
  | "export_service_webview_auth" | "import_service_webview_auth";
type SoftwareUpdateCommand = "check_software_update" | "get_software_update_status" | "open_software_update" | "install_software_update";

declare global {
  interface Window {
    drawStudioHost?: { customTitleBar?: boolean; invoke(command: ServiceCommand | SoftwareUpdateCommand, args: Record<string, unknown>): Promise<unknown> };
    drawStudioSaveBeforeExit?: () => Promise<void>;
  }
}

export function hasNativeWebview() {
  return isTauri() || typeof window !== "undefined" && !!window.drawStudioHost;
}
export function nativeWebviewInvoke<T = void>(command: ServiceCommand, service: CanvasService, args: Record<string, unknown> = {}): Promise<T> {
  const payload = { service, ...args };
  if (isTauri()) return invoke<T>(command, payload);
  if (typeof window !== "undefined" && window.drawStudioHost) return window.drawStudioHost.invoke(command, payload) as Promise<T>;
  return Promise.reject(new Error("Draw studio 桌面浏览器不可用。"));
}

