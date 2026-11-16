import type { Page } from "playwright";
import { museComposerSelector } from "./muse-session-state";

export type MuseSendReadiness = { ready: boolean; message?: string };

/** Observe website readiness only; callers decide how long to wait. No reloads or sends. */
export async function readMuseSendReadiness(page: Page): Promise<MuseSendReadiness> {
  if (page.isClosed()) return { ready: false, message: "Muse 浏览器连接已关闭，尚未发送。" };
  try {
    return await page.evaluate(selector => {
      const blocked = (message: string) => ({ ready: false, message });
      if (document.readyState !== "complete") return blocked("正在等待 Muse 网页加载完成，尚未发送。");
      const chat = '[class*="hatch-chat-groupable-bubble"], [class*="chat-user-bubble"], [class*="hatch-agent-bubble-bg"]';
      const hidden = (element: Element) => {
        if (element.closest('[hidden], [aria-hidden="true"]')) return true;
        for (let current: Element | null = element; current; current = current.parentElement) {
          const css = getComputedStyle(current);
          if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse") return true;
        }
        return false;
      };
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return !hidden(element) && rect.width > 0 && rect.height > 0;
      };
      // This is the site's observed shell attribute (also checked by muse2api).
      // Its absence is not a fabricated connection error on other page variants.
      const shells = [...document.querySelectorAll('[data-hatch-shell-hydration-state]')]
        .filter(element => !hidden(element) && !element.closest(chat));
      if (shells.some(element => element.getAttribute("data-hatch-shell-hydration-state") !== "hydrated"))
        return blocked("Muse 工作区正在初始化连接，尚未发送。");

      const connecting = /^(?:(?:connecting|reconnecting)(?:\s+to\s+(?:muse|server|workspace))?|(?:正在)?(?:重新)?连接(?:中)?|正在重连)[.。…\s]*$/i;
      const disconnected = /^(?:offline|you(?:'|’)re offline|you are offline|disconnected|connection lost|connection failed|unable to connect|网络已断开|网络连接已断开|网络连接断开|连接已断开|连接断开|连接失败|无法连接|离线)[.。!！…\s]*$/i;
      // Exact, short UI labels only. Never inspect user/assistant messages, editor
      // contents, or broad body text: a prompt can legitimately quote these words.
      const candidates = [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live], header, span, p, div')];
      for (const element of candidates) {
        if (!visible(element) || element.closest(chat) || element.closest('textarea, input, [contenteditable]') || element.querySelector(chat + ', textarea, input, [contenteditable]')) continue;
        const text = (element instanceof HTMLElement ? element.innerText : element.textContent ?? "").trim();
        if (text.length > 100) continue;
        if (connecting.test(text)) return blocked("Muse 正在连接服务，连接就绪后再发送。");
        if (disconnected.test(text)) return blocked("Muse 网页提示连接中断，正在等待连接恢复，尚未发送。");
      }
      const composer = [...document.querySelectorAll(selector)].some(element =>
        visible(element) && !element.matches(":disabled") && !element.closest('[inert], [aria-disabled="true"]') && !element.closest(chat));
      if (!composer) return blocked("正在等待 Muse 输入框就绪，尚未发送。");
      return { ready: true };
    }, museComposerSelector);
  } catch {
    // Navigation can replace the execution context between observations.
    return { ready: false, message: "Muse 页面正在切换，正在等待连接就绪，尚未发送。" };
  }
}
