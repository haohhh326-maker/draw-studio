import type { Page } from "playwright";

export type MuseActivity = { working: boolean; message?: string };

/** Avatar activity describes the open Muse page. It does not acknowledge a task. */
export async function readMuseActivity(page: Page): Promise<MuseActivity> {
  return page.evaluate(() => {
    const pillSelector = '[data-hatch-avatar-accessory="status-pill"][data-hatch-avatar-status-pill-visible="true"]';
    const profileAvatarSelector = '[role="img"][data-hatch-avatar-interaction="true"][aria-label="Muse虚拟形象"], [role="img"][data-hatch-avatar-interaction="true"][aria-label="Muse avatar"]';
    const transcriptSelector = '[class*="hatch-chat-groupable-bubble"], form, [contenteditable="true"]';
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      for (let current: Element | null = element; current; current = current.parentElement) {
        const css = getComputedStyle(current);
        if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse" || css.opacity === "0") return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const scopes = new Set<Element>(document.querySelectorAll(pillSelector));
    for (const avatar of document.querySelectorAll(profileAvatarSelector)) {
      if (!visible(avatar)) continue;
      // Profile panels keep the avatar, name and activity together. Stop before
      // reaching the conversation or application shell so chat text is excluded.
      for (let parent = avatar.parentElement; parent && !/^(BODY|HTML|MAIN|FORM)$/.test(parent.tagName); parent = parent.parentElement) {
        if (parent.querySelector(transcriptSelector)) break;
        if (parent.querySelector('h1, h2, h3, [role="heading"]')) scopes.add(parent);
        if (parent.matches('[role="dialog"]')) { scopes.add(parent); break; }
      }
    }
    for (const scope of scopes) {
      if (!visible(scope) || scope.closest(transcriptSelector)) continue;
      const names = new Set([...scope.querySelectorAll('h1, h2, h3, [role="heading"]')]
        .map(element => normalize(element.textContent ?? "")));
      const label = scope.getAttribute("aria-label");
      if (label) names.add(normalize(label));
      for (const element of [scope, ...scope.querySelectorAll("*")]) {
        if (!visible(element) || element.closest(transcriptSelector)) continue;
        const text = normalize([...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent ?? "").join(""));
        if (!text || names.has(text) || element.matches('h1, h2, h3, [role="heading"]')) continue;
        if (/^(?:努力工作中|正在工作|工作中|working hard|working)[.。…!！]*$/i.test(text))
          return { working: true, message: text };
      }
    }
    return { working: false };
  });
}
