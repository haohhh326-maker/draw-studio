import type { Page } from "playwright";
import { readMuseTurnSnapshot, type MuseTurnReference } from "./muse-turn-anchor";

export type MuseTurnMedia = { src: string; kind: "image" | "video"; width: number; height: number };

/** Read assistant attachments from one anchored turn, or legacy conversation media. */
export async function readMuseTurnMedia(page: Page, marker?: MuseTurnReference): Promise<MuseTurnMedia[]> {
  // Delivery and media must use the same verified turn for both historical
  // string markers and private anchors. Only unanchored jobs use the old scan.
  if (marker !== undefined) return (await readMuseTurnSnapshot(page, marker)).media;
  return page.evaluate(() => {
    const attachmentSelector = '[data-testid^="hatch-chat-attachment-presentation-"]';
    const mediaButtonSelector = 'button[class*="hatch-chat-groupable-bubble"][data-pel-click="chat_media_click"]';
    const videoWrapperSelector = '[data-hatch-video-wrapper="true"][data-hatch-video-src]';
    const generatedVideoWrapper = (element: Element) => element.matches(videoWrapperSelector)
      && element.getAttribute("role") === "button" && element.getAttribute("aria-busy") !== "true"
      && /^(?:open animated video\b|打开(?:生成的|动画)?视频)/i.test(element.getAttribute("aria-label")?.trim() ?? "");
    const visible = (element: Element) => {
      if (element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getBoundingClientRect().width || !element.getBoundingClientRect().height) return false;
      for (let parent: Element | null = element; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    };
    const generatedMediaButtonKind = (element: Element): "image" | "video" | undefined => {
      if (!element.matches(mediaButtonSelector) || element.getAttribute("aria-busy") === "true") return;
      const label = element.getAttribute("aria-label")?.trim() ?? "";
      if (/^(?:打开生成的图片|open(?: the)? generated image\b)/i.test(label)) return "image";
      if (/^(?:打开生成的视频|open(?: the)? generated video\b)/i.test(label)) return "video";
    };
    const excludedSelector = 'form, [class*="chat-user-bubble"], [class*="group/msg"], [data-hatch-media-owner="avatar-layer"], [data-hatch-avatar-layer]';
    const list: { src: string; kind: "image" | "video"; width: number; height: number }[] = [];
    const seen = new Set<string>();
    const selector = attachmentSelector + ', [class*="hatch-agent-bubble-bg"] img, [class*="hatch-agent-bubble-bg"] video, ' + mediaButtonSelector + ', ' + videoWrapperSelector;
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest(excludedSelector)) continue;
      const wrapper = el.closest(videoWrapperSelector);
      if (wrapper) {
        if (!generatedVideoWrapper(wrapper) || !visible(wrapper)) continue;
        const video = wrapper.querySelector("video"), src = wrapper.getAttribute("data-hatch-video-src");
        if (!video || !src || (video.currentSrc || video.src) !== src || video.videoWidth <= 0 || video.videoHeight <= 0 || seen.has(src)) continue;
        seen.add(src);
        list.push({ src, kind: "video", width: video.videoWidth, height: video.videoHeight });
        continue;
      }
      const video = el instanceof HTMLVideoElement ? el : el.querySelector("video");
      const image = el instanceof HTMLImageElement ? el : el.querySelector("img");
      const attachment = el.closest(attachmentSelector);
      const button = el.closest(mediaButtonSelector);
      const buttonKind = button ? generatedMediaButtonKind(button) : undefined;
      if (button && !buttonKind) continue;
      const videoAttachment = (attachment?.getAttribute("data-testid") ?? "").includes("video") || buttonKind === "video";
      const imageAttachment = (attachment?.getAttribute("data-testid") ?? "").includes("image") || buttonKind === "image";
      const media = videoAttachment ? video : imageAttachment ? image : video || image;
      if (!media || media.closest(excludedSelector)) continue;
      // An image nested in a video card is a thumbnail, never an image result.
      if (media instanceof HTMLImageElement && (media.closest("video") || videoAttachment || attachment?.querySelector("video"))) continue;
      if (media instanceof HTMLVideoElement && imageAttachment) continue;
      const src = media.currentSrc || media.src;
      if (!src || seen.has(src) || /avatar|emoji/i.test(src)) continue;
      seen.add(src);
      const isVideo = media instanceof HTMLVideoElement;
      list.push({ src, kind: isVideo ? "video" : "image", width: isVideo ? media.videoWidth : media.naturalWidth, height: isVideo ? media.videoHeight : media.naturalHeight });
    }
    return list;
  });
}
