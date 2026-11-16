import type { MuseSession } from "../src/muse/client";

export const museComposerSelector = 'textarea:not([disabled]):not([readonly]), [contenteditable="true"][role="textbox"], [contenteditable="plaintext-only"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], .ProseMirror[contenteditable="true"], form [contenteditable="true"]';
export function isMusePageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && ["https://muse.ai", "https://www.muse.ai"].includes(url.origin);
  } catch { return false; }
}
export type MusePageState = { url: string; loading?: boolean; composer: boolean; workspace?: boolean; login?: boolean; restricted?: boolean };
export function classifyMusePage(state: MusePageState): MuseSession {
  if (!isMusePageUrl(state.url)) return { status: "login-required", message: "请在 Muse 专用窗口完成官方登录。" };
  if (state.loading) return { status: "checking", message: "Muse 页面正在加载，正在同步登录状态…" };
  if (state.restricted) return { status: "waiting-list", message: "此 Muse 账号尚未开放，请在 Muse 专用窗口切换其他可用账号。" };
  if (state.login) return { status: "login-required", message: "请在 Muse 专用窗口完成登录，画布会自动更新连接状态。" };
  // The signed-in homepage also hosts the composer; /thread/ is not required.
  if (state.composer) return { status: "connected", message: "Muse 账号已连接，可从画布提交生成。" };
  if (state.workspace) return { status: "checking", message: "已识别 Muse 工作区，正在等待生成输入框就绪…" };
  return { status: "checking", message: "Muse 页面尚未出现可用输入框，正在等待页面就绪。可在 Muse 专用窗口进入对话主页。" };
}
