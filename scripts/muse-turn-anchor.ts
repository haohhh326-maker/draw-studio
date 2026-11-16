import type { Page } from "playwright";

/** Private metadata only. Neither these hashes nor a marker are sent to Muse. */
export type MuseTurnAnchor = {
  promptHash: string;
  precedingUserHashes: string[];
  /** Canonical history excludes screen-reader speaker labels and controls. */
  precedingUserPromptHashes?: string[];
  /** Private preparation identity and conversation location, never sent as text. */
  preparationId?: string;
  pageUrl?: string;
};
export type MuseTurnReference = string | MuseTurnAnchor;
export type MuseTargetStructureNode = {
  tag: string; className?: string; testId?: string; role?: string;
  textLength: number; childCount: number; children?: MuseTargetStructureNode[];
};
export type MuseDeliveryDiagnostic = {
  reason: "invalid-reference" | "marker-missing" | "marker-ambiguous" | "target-absent"
    | "binding-invalidated" | "preparation-changed" | "page-changed" | "target-detached"
    | "prefix-mismatch" | "prompt-mismatch" | "no-assistant-content"
    | "explicit-failure" | "delivery-unconfirmed" | "explicit-acceptance" | "assistant-content";
  userCount: number;
  bubbleCount: number;
  /** -1 when an invalid or legacy reference has no known target position. */
  expectedIndex: number;
  /** Current DOM position of the verified target, after transcript trimming. */
  targetIndex?: number;
  emptyUserBubbleCount: number;
  nestedBubbleCount: number;
  candidateHashMatches?: boolean;
  prefixMatches?: boolean;
  /** Assistant bubbles after the selected candidate and before the next user. */
  assistantCount?: number;
  /** Visible non-composer attachment cards across the page, including uploads. */
  attachmentCount?: number;
  mediaCount?: number;
  continuing?: boolean;
  matchingPromptIndices?: number[];
  /** Lengths only; no candidate text or digest is emitted. */
  targetTextLength?: number;
  targetRawTextLength?: number;
  targetRawNormalizedTextLength?: number;
  targetInnerTextLength?: number;
  targetTextVariantMatches?: {
    rawTextContent: boolean; innerText: boolean; withoutLayoutSeparators: boolean;
    includingButtonText: boolean; includingButtonTextWithoutLayout: boolean;
    userRoleText: boolean; nfc: boolean; nfkc: boolean; withoutZeroWidthCharacters: boolean;
  };
  targetFormat?: {
    lineBreakElements: number; sourceNewlines: number; blockElements: number;
    buttons: number; roleButtons: number; links: number; attachmentCards: number;
    userRoleElements: number; hiddenElements: number; markdownElements: number;
    asciiAtSigns: number; fullWidthAtSigns: number; nonBreakingSpaces: number; zeroWidthCharacters: number;
  };
  targetPlainLeafMatches?: number;
  targetSubtreeMatches?: Pick<MuseTargetStructureNode, "tag" | "className" | "testId" | "role" | "textLength" | "childCount">[];
  targetStructure?: MuseTargetStructureNode;
  targetDiagnosticSample?: {
    leafCount: number; sampledLeaves: number; subtreeCount: number; sampledSubtrees: number;
    matchedSubtrees: number; structureTruncated: boolean;
  };
  /** Counts can overlap. Range starts at the anchor (including its uploads)
   * and ends before the next user bubble; source/dimension counts are img/video only. */
  targetMediaRange?: {
    attachmentCards: number; images: number; videos: number; inAssistantRoots: number;
    outsideAssistantRoots: number; standaloneAttachmentCards: number; insideUserAnchor: number;
    excludedByGroupMessage: number; excludedByUserRole: number; excludedByComposer: number;
    hidden: number; withoutSource: number; zeroDimensions: number;
  };
};
type Delivery = { state: "missing" | "ambiguous" | "pending" | "unconfirmed" | "failed" | "accepted"; message?: string; diagnostic?: MuseDeliveryDiagnostic };
type Media = { src: string; kind: "image" | "video"; width: number; height: number };
export type Observation = { delivery: Delivery; media: Media[]; anchor?: MuseTurnAnchor };
type Input = { mode: "prepare"; prompt: string } | { mode: "read"; reference: MuseTurnReference };

// This entire function executes in the page. Keep it self-contained: imported
// helpers and module closures are not available after Playwright serializes it.
async function observeMuseTurnInPage(input: Input): Promise<Observation> {
  const bubbleSelector = '[class*="hatch-chat-groupable-bubble"]';
  const userSelector = '[class*="chat-user-bubble"]';
  const assistantSelector = '[class*="hatch-agent-bubble-bg"]';
  const attachmentSelector = '[data-testid^="hatch-chat-attachment-presentation-"]';
  const mediaButtonSelector = 'button[class*="hatch-chat-groupable-bubble"][data-pel-click="chat_media_click"]';
  const videoWrapperSelector = '[data-hatch-video-wrapper="true"][data-hatch-video-src]';
  const generatedVideoWrapper = (element: Element) => element.matches(videoWrapperSelector)
    && element.getAttribute("role") === "button" && element.getAttribute("aria-busy") !== "true"
    && /^(?:open animated video\b|打开(?:生成的|动画)?视频)/i.test(element.getAttribute("aria-label")?.trim() ?? "");
  const generatedMediaButtonKind = (element: Element): "image" | "video" | undefined => {
    if (!element.matches(mediaButtonSelector) || element.getAttribute("aria-busy") === "true") return;
    const label = element.getAttribute("aria-label")?.trim() ?? "";
    if (/^(?:打开生成的图片|open(?: the)? generated image\b)/i.test(label)) return "image";
    if (/^(?:打开生成的视频|open(?: the)? generated video\b)/i.test(label)) return "video";
  };
  // group/msg is also used by real user-message rows. It excludes user
  // attachments from results, but must not exclude those rows from chronology.
  const composerExcluded = 'form';
  const mediaExcluded = composerExcluded + ', [class*="group/msg"]';
  type Binding = { key: string; url: string; element: Element; invalidated: boolean; observer: MutationObserver };
  type Preparation = { id: string; users: Set<Element> };
  const bindingKey = Symbol.for("drawstudio.muse.verified-turn.v1");
  const generationKey = Symbol.for("drawstudio.muse.turn-generation.v1");
  const preparationKey = Symbol.for("drawstudio.muse.turn-preparation.v1");
  const pageState = globalThis as unknown as Record<symbol, Binding | undefined>;
  const generationState = globalThis as unknown as Record<symbol, number | undefined>;
  const preparationState = globalThis as unknown as Record<symbol, Preparation | undefined>;
  const generation = generationState[generationKey] ?? 0;
  const discardBinding = (binding = pageState[bindingKey]) => {
    binding?.observer.disconnect();
    if (pageState[bindingKey] === binding) delete pageState[bindingKey];
  };
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const hidden = (element: Element) => {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return true;
    for (let current: Element | null = element; current; current = current.parentElement) {
      const css = getComputedStyle(current);
      if (css.display === "none" || css.visibility === "hidden" || css.visibility === "collapse" || css.opacity === "0") return true;
    }
    return false;
  };
  const visible = (element: Element) => !hidden(element) && !!element.getBoundingClientRect().width && !!element.getBoundingClientRect().height;
  const changesContentOrPlacement = (record: MutationRecord, element: Element) => {
    if (record.type === "attributes") return false;
    return element === record.target || element.contains(record.target)
      || [...record.removedNodes].some(node => node === element || node.contains(element));
  };
  const hasRole = (bubble: Element, selector: string) => !!bubble.closest(selector) || [...bubble.querySelectorAll(selector)].some(visible);
  const renderedText = (element: Element) => (element instanceof HTMLElement ? element.innerText : element.textContent ?? "").trim();
  const textOf = (element: Element, assistant = false, layoutSeparators = true, includeButtonText = false, excludeScreenReaderText = false) => {
    const omit = (includeButtonText ? '' : 'button, [role="button"], ') + 'input, textarea, select, option, svg, img, video, audio, ' + attachmentSelector
      + (assistant ? ', a, [role="status"], [role="progressbar"]' : "")
      + (excludeScreenReaderText ? ', .sr-only' : "");
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (!(node instanceof Element) || hidden(node) || node.matches(omit)) return "";
      if (node.tagName === "BR") return "\n";
      const content = [...node.childNodes].map(walk).join("");
      return layoutSeparators && /^(block|flex|grid|table|list-item|flow-root)/.test(getComputedStyle(node).display) ? "\n" + content + "\n" : content;
    };
    return normalize(walk(element));
  };
  const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(text))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const bubbles = [...document.querySelectorAll(bubbleSelector)].filter(element => visible(element) && !element.closest(composerExcluded)
    && !(element.matches(mediaButtonSelector + ", " + videoWrapperSelector) && element.closest(userSelector)));
  const users = bubbles.filter(bubble => hasRole(bubble, userSelector));
  const userTexts = users.map(bubble => textOf(bubble));
  const userPromptTexts = users.map(bubble => textOf(bubble, false, true, false, true));
  if (input.mode === "prepare") {
    generationState[generationKey] = generation + 1;
    discardBinding();
    const preparationId = crypto.randomUUID(), pageUrl = location.href;
    preparationState[preparationKey] = { id: preparationId, users: new Set(users) };
    // Capture the full prefix synchronously before digest yields to the page.
    const [promptHash, precedingUserHashes, precedingUserPromptHashes] = await Promise.all([
      hash(input.prompt), Promise.all(userTexts.map(hash)), Promise.all(userPromptTexts.map(hash)),
    ]);
    return { delivery: { state: "missing" }, media: [], anchor: {
      promptHash, precedingUserHashes, precedingUserPromptHashes, preparationId, pageUrl,
    } };
  }

  const reference = input.reference;
  const diagnostic: MuseDeliveryDiagnostic = {
    reason: "target-absent", userCount: users.length, bubbleCount: bubbles.length, expectedIndex: -1,
    emptyUserBubbleCount: userTexts.filter(text => !text).length,
    nestedBubbleCount: bubbles.filter(bubble => bubbles.some(parent => parent !== bubble && parent.contains(bubble))).length,
    attachmentCount: [...document.querySelectorAll(attachmentSelector)].filter(element => visible(element) && !element.closest(composerExcluded)).length,
    mediaCount: 0,
  };
  const observation = (state: Delivery["state"], reason: MuseDeliveryDiagnostic["reason"], media: Media[] = [], message?: string): Observation => ({
    delivery: { state, ...(message === undefined ? {} : { message }), diagnostic: { ...diagnostic, reason } }, media,
  });
  let anchor: Element | undefined;
  let binding: Binding | undefined, continuing = false, shiftedAnchor = false;
  let visiblePromptHashes: string[] | undefined;
  if (typeof reference === "string") {
    if (!reference.trim()) return observation("missing", "invalid-reference");
    const matches = users.filter(bubble => renderedText(bubble).includes(reference));
    if (matches.length !== 1) return observation(matches.length ? "ambiguous" : "missing", matches.length ? "marker-ambiguous" : "marker-missing");
    anchor = matches[0];
    diagnostic.expectedIndex = users.indexOf(anchor);
  } else {
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.promptHash) || !Array.isArray(reference.precedingUserHashes)
      || reference.precedingUserHashes.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
      || (reference.precedingUserPromptHashes !== undefined && (!Array.isArray(reference.precedingUserPromptHashes)
        || reference.precedingUserPromptHashes.length !== reference.precedingUserHashes.length
        || reference.precedingUserPromptHashes.some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))))
      || (reference.preparationId !== undefined && (typeof reference.preparationId !== "string" || !reference.preparationId))
      || (reference.pageUrl !== undefined && typeof reference.pageUrl !== "string"))
      return observation("missing", "invalid-reference");
    if (reference.pageUrl !== undefined && reference.pageUrl !== location.href) return observation("missing", "page-changed");
    diagnostic.expectedIndex = reference.precedingUserHashes.length;
    const key = (reference.preparationId ?? "") + ":" + reference.promptHash + ":" + reference.precedingUserHashes.join(",");
    const existing = pageState[bindingKey];
    if (existing?.key === key && existing.url !== location.href) { discardBinding(existing); return observation("missing", "page-changed"); }
    const retainedElement = existing?.key === key && users.includes(existing.element) ? existing.element : undefined;
    if (existing && (existing.invalidated || existing.url !== location.href || !users.includes(existing.element))) discardBinding(existing);
    continuing = !!existing && pageState[bindingKey] === existing && existing.key === key;
    diagnostic.continuing = continuing;
    anchor = continuing ? existing!.element : retainedElement ?? users[reference.precedingUserHashes.length];
    shiftedAnchor = !!retainedElement && users.indexOf(retainedElement) < reference.precedingUserHashes.length;
    if (!continuing) {
      const changedUsers = new Set<Element>();
      const guard = new MutationObserver(records => {
        for (const record of records) for (const user of users) {
          if (changesContentOrPlacement(record, user)) changedUsers.add(user);
        }
      });
      guard.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
      try {
        if (!anchor || await hash(textOf(anchor, false, true, false, true)) !== reference.promptHash) {
          // The virtual transcript can trim old rows before the first observation.
          // Re-rendering can replace the verified element, while virtualization
          // removes old rows. Revalidate complete prompt content and the surviving
          // historical suffix below instead of permanently invalidating a turn.
          visiblePromptHashes = await Promise.all(userPromptTexts.map(hash)).catch(() => undefined);
          const matches = visiblePromptHashes?.flatMap((value, index) => value === reference.promptHash ? [index] : []) ?? [];
          const preparation = preparationState[preparationKey];
          const candidate = matches.length === 1 ? users[matches[0]] : undefined;
          const predatesPreparation = candidate && preparation && preparation.id === reference.preparationId && preparation.users.has(candidate);
          if (candidate && matches[0] < reference.precedingUserHashes.length && !predatesPreparation) {
            anchor = candidate;
            shiftedAnchor = true;
          }
        }
      } finally { guard.disconnect(); }
      if (changedUsers.size) {
        // This snapshot raced a render. The next observation can verify the
        // settled DOM, including a newly mounted node for this same message.
        return observation("missing", "binding-invalidated");
      }
    }
    if (!anchor) {
      // Diagnostic-only hashing must not turn an otherwise missing observation
      // into an exception. It never selects a different candidate.
      try {
        const hashes = await Promise.all(userTexts.map(hash));
        diagnostic.matchingPromptIndices = (visiblePromptHashes ?? hashes).flatMap((value, index) => value === reference.promptHash ? [index] : []);
        diagnostic.prefixMatches = hashes.length >= reference.precedingUserHashes.length
          && reference.precedingUserHashes.every((value, index) => hashes[index] === value);
      } catch { /* Preserve the original missing result if diagnostics fail. */ }
      return observation("missing", "target-absent");
    }
    if (continuing) binding = existing;
    else {
      const element = anchor;
      const observer = new MutationObserver(records => {
        // A render invalidates this snapshot, not the persisted turn identity.
        // Its replacement must pass the full content/context checks on reread.
        if (records.some(record => changesContentOrPlacement(record, element))) {
          binding!.invalidated = true; binding!.observer.disconnect();
        }
      });
      binding = { key, url: location.href, element, invalidated: false, observer };
      observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
    }
  }

  try {
    // Capture diagnostic alternatives from this same candidate before digest
    // yields. They are never used to select a turn or accept its response.
    // Muse prepends an sr-only speaker label to the visible prompt paragraph.
    // Legacy persisted history retains its whole-bubble semantics. New anchors
    // also carry canonical body hashes so speaker/receipt redraws are harmless.
    diagnostic.targetIndex = users.indexOf(anchor);
    const candidateText = textOf(anchor, false, true, false, true);
    const rawCandidateText = anchor.textContent ?? "", innerCandidateText = renderedText(anchor);
    const roleElements = anchor.matches(userSelector) ? [anchor] : [...anchor.querySelectorAll(userSelector)].filter(visible);
    const descendants = [...anchor.querySelectorAll("*")];
    const structuralAttribute = (value: string | null) => value ? value.split(/\s+/).map(token =>
      /(?:https?:|blob:|data:|\/\/|url\()|[a-f0-9]{32,}/i.test(token) ? "[redacted]" : token).join(" ").slice(0, 160) : undefined;
    const structureMetadata = (element: Element) => ({
      tag: element.tagName.toLowerCase(),
      ...(element.getAttribute("class") ? { className: structuralAttribute(element.getAttribute("class")) } : {}),
      ...(element.getAttribute("data-testid") ? { testId: structuralAttribute(element.getAttribute("data-testid")) } : {}),
      ...(element.getAttribute("role") ? { role: structuralAttribute(element.getAttribute("role")) } : {}),
      textLength: textOf(element).length, childCount: element.childNodes.length,
    });
    const diagnosticOmit = 'button, [role="button"], input, textarea, select, option, svg, img, video, audio, ' + attachmentSelector;
    const subtreeElements = descendants.filter(element => visible(element) && !element.closest(diagnosticOmit));
    const subtreeSamples = subtreeElements.slice(0, 96).map(element => ({ metadata: structureMetadata(element), text: textOf(element) }));
    const leafTexts: string[] = [];
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement, text = normalize(node.textContent ?? "");
      if (text && parent && !hidden(parent) && !parent.closest(diagnosticOmit)) leafTexts.push(text);
    }
    const leafSamples = leafTexts.slice(0, 128);
    let structureCount = 0, structureTruncated = false;
    const structureTree = (node: Node, depth = 0): MuseTargetStructureNode | undefined => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = normalize(node.textContent ?? "").length;
        if (!textLength) return;
        if (structureCount >= 24) { structureTruncated = true; return; }
        structureCount++;
        return { tag: "#text", textLength, childCount: 0 };
      }
      if (!(node instanceof Element) || hidden(node)) return;
      if (structureCount >= 24) { structureTruncated = true; return; }
      structureCount++;
      const result: MuseTargetStructureNode = structureMetadata(node);
      if (depth >= 5) { if (node.childNodes.length) structureTruncated = true; return result; }
      const children = [...node.childNodes].flatMap(child => { const item = structureTree(child, depth + 1); return item ? [item] : []; });
      if (children.length) result.children = children;
      return result;
    };
    const targetStructure = structureTree(anchor);
    const zeroWidth = /[\u200B-\u200D\u2060\uFEFF]/g;
    const variants = {
      rawTextContent: rawCandidateText, innerText: innerCandidateText,
      withoutLayoutSeparators: textOf(anchor, false, false),
      includingButtonText: textOf(anchor, false, true, true),
      includingButtonTextWithoutLayout: textOf(anchor, false, false, true),
      nfc: candidateText.normalize("NFC"), nfkc: candidateText.normalize("NFKC"),
      withoutZeroWidthCharacters: candidateText.replace(zeroWidth, ""),
    };
    const roleTexts = roleElements.map(element => textOf(element));
    diagnostic.targetTextLength = candidateText.length;
    diagnostic.targetRawTextLength = rawCandidateText.length;
    diagnostic.targetRawNormalizedTextLength = normalize(rawCandidateText).length;
    diagnostic.targetInnerTextLength = normalize(innerCandidateText).length;
    diagnostic.targetFormat = {
      lineBreakElements: anchor.querySelectorAll("br").length,
      sourceNewlines: (rawCandidateText.match(/\r\n|\r|\n/g) ?? []).length,
      blockElements: descendants.filter(element => /^(block|flex|grid|table|list-item|flow-root)/.test(getComputedStyle(element).display)).length,
      buttons: anchor.querySelectorAll("button").length, roleButtons: anchor.querySelectorAll('[role="button"]').length,
      links: anchor.querySelectorAll("a").length, attachmentCards: anchor.querySelectorAll(attachmentSelector).length,
      userRoleElements: roleElements.length, hiddenElements: descendants.filter(hidden).length,
      markdownElements: anchor.querySelectorAll("strong, b, em, i, code, pre, blockquote, ul, ol, li").length,
      asciiAtSigns: (rawCandidateText.match(/@/g) ?? []).length, fullWidthAtSigns: (rawCandidateText.match(/＠/g) ?? []).length,
      nonBreakingSpaces: (rawCandidateText.match(/\u00a0/g) ?? []).length, zeroWidthCharacters: (rawCandidateText.match(zeroWidth) ?? []).length,
    };
    // Capture labels and the scoped response before awaiting any hashes. The
    // prefix, target and response must all belong to this one DOM observation.
    const labels = new Set<string>();
    for (let row = anchor.parentElement; row && !/^(MAIN|BODY|HTML|FORM)$/.test(row.tagName); row = row.parentElement) {
      const owned = [...row.querySelectorAll(bubbleSelector)].filter(visible);
      if (owned.length !== 1 || owned[0] !== anchor) break;
      for (const element of row.querySelectorAll("*")) {
        if (!visible(element) || element.closest(bubbleSelector) || element.querySelector(bubbleSelector) || element.closest(composerExcluded + ", nav, aside, header, footer")) continue;
        for (const value of [renderedText(element), element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-delivery-status")]) {
          if (value && normalize(value)) labels.add(normalize(value));
        }
      }
    }
    const roots: Element[] = [];
    for (const bubble of bubbles.slice(bubbles.indexOf(anchor) + 1)) {
      if (hasRole(bubble, userSelector)) break;
      if (hasRole(bubble, assistantSelector) || generatedMediaButtonKind(bubble) || generatedVideoWrapper(bubble)) roots.push(bubble);
    }
    diagnostic.assistantCount = roots.length;
    const nextUser = bubbles.slice(bubbles.indexOf(anchor) + 1).find(bubble => hasRole(bubble, userSelector));
    const rangeElements = [...document.querySelectorAll(attachmentSelector + ", " + videoWrapperSelector + ", img, video")].filter(element => {
      const after = anchor.compareDocumentPosition(element);
      return !(after & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(after & Node.DOCUMENT_POSITION_FOLLOWING)
        && (!nextUser || !!(element.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    const rangeMedia = rangeElements.filter((element): element is HTMLImageElement | HTMLVideoElement => element instanceof HTMLImageElement || element instanceof HTMLVideoElement);
    const inAssistantRoots = (element: Element) => roots.some(root => root.contains(element));
    diagnostic.targetMediaRange = {
      attachmentCards: rangeElements.filter(element => element.matches(attachmentSelector)).length,
      images: rangeMedia.filter(element => element instanceof HTMLImageElement).length,
      videos: rangeMedia.filter(element => element instanceof HTMLVideoElement).length,
      inAssistantRoots: rangeElements.filter(inAssistantRoots).length,
      outsideAssistantRoots: rangeElements.filter(element => !inAssistantRoots(element)).length,
      standaloneAttachmentCards: rangeElements.filter(element => element.matches(attachmentSelector)
        && !element.closest(bubbleSelector + ", " + mediaExcluded + ", " + userSelector)).length,
      insideUserAnchor: rangeElements.filter(element => anchor.contains(element)).length,
      excludedByGroupMessage: rangeElements.filter(element => !!element.closest('[class*="group/msg"]')).length,
      excludedByUserRole: rangeElements.filter(element => !!element.closest(userSelector)).length,
      excludedByComposer: rangeElements.filter(element => !!element.closest(composerExcluded)).length,
      hidden: rangeElements.filter(element => !visible(element)).length,
      withoutSource: rangeMedia.filter(element => !(element.currentSrc || element.src)).length,
      zeroDimensions: rangeMedia.filter(element => element instanceof HTMLVideoElement
        ? !element.videoWidth || !element.videoHeight : !element.naturalWidth || !element.naturalHeight).length,
    };
    const media: Media[] = [], seen = new Set<string>(), rootSet = new Set(roots);
    // Muse renders generated attachments as sibling cards as well as inside
    // assistant bubbles. Keep both layouts within this verified turn; never
    // use global/latest media or a user's uploaded reference as the result.
    const resultExcluded = mediaExcluded + ", " + userSelector + ', nav, aside, header, footer, [data-hatch-media-owner="avatar-layer"], [data-hatch-avatar-layer]';
    const ownsResult = (element: Element) => {
      if (anchor.contains(element) || element.closest(resultExcluded)) return false;
      const bubble = element.closest(bubbleSelector);
      if (bubble) return rootSet.has(bubble);
      return !!element.closest(attachmentSelector);
    };
    for (const element of rangeElements) {
      if (!ownsResult(element)) continue;
      const wrapper = element.closest(videoWrapperSelector);
      if (wrapper) {
        if (!generatedVideoWrapper(wrapper) || !visible(wrapper) || !ownsResult(wrapper)) continue;
        const video = wrapper.querySelector("video"), src = wrapper.getAttribute("data-hatch-video-src");
        if (!video || !src || (video.currentSrc || video.src) !== src || video.videoWidth <= 0 || video.videoHeight <= 0 || seen.has(src)) continue;
        seen.add(src);
        media.push({ src, kind: "video", width: video.videoWidth, height: video.videoHeight });
        continue;
      }
      const attachment = element.closest(attachmentSelector);
      const button = element.closest(mediaButtonSelector);
      const buttonKind = button ? generatedMediaButtonKind(button) : undefined;
      if (button && !buttonKind) continue;
      const videoAttachment = (attachment?.getAttribute("data-testid") ?? "").includes("video") || buttonKind === "video";
      const imageAttachment = (attachment?.getAttribute("data-testid") ?? "").includes("image") || buttonKind === "image";
      const usable = (item: HTMLImageElement | HTMLVideoElement) => visible(item) && !!(item.currentSrc || item.src);
      const video = element instanceof HTMLVideoElement ? element : [...element.querySelectorAll("video")].find(usable);
      const image = element instanceof HTMLImageElement ? element : [...element.querySelectorAll("img")].find(usable);
      const selected = videoAttachment ? video : imageAttachment ? image : video && usable(video) ? video : image;
      if (!selected || !usable(selected) || !ownsResult(selected)) continue;
      if (selected instanceof HTMLImageElement && (videoAttachment || (!imageAttachment && attachment && [...attachment.querySelectorAll("video")].some(usable)))) continue;
      if (selected instanceof HTMLVideoElement && imageAttachment) continue;
      const src = selected.currentSrc || selected.src;
      if (!src || seen.has(src) || /avatar|emoji/i.test(src)) continue;
      seen.add(src);
      const isVideo = selected instanceof HTMLVideoElement;
      media.push({ src, kind: isVideo ? "video" : "image", width: isVideo ? selected.videoWidth : selected.naturalWidth, height: isVideo ? selected.videoHeight : selected.naturalHeight });
    }
    diagnostic.mediaCount = media.length;
    const meaningfulAssistant = media.length > 0 || roots.some(root => {
      const text = textOf(root, true, true, false, true);
      if (text && !/^(?:[.\s…]+|(?:thinking|loading|generating|please wait|正在思考|思考中|加载中|正在加载|正在生成|生成中)[.\s…！!。]*)$/i.test(text)) return true;
      return [...root.querySelectorAll("img, video, audio")].some(element => {
        if (!visible(element) || element.closest('button, a, [role="button"], ' + mediaExcluded)) return false;
        const item = element as HTMLImageElement | HTMLMediaElement;
        const src = item.currentSrc || item.src || element.querySelector("source")?.getAttribute("src");
        return !!src && !/avatar|emoji/i.test(src);
      });
    });
    if (typeof reference !== "string") {
      const index = users.indexOf(anchor);
      const history = reference.precedingUserPromptHashes ?? reference.precedingUserHashes;
      const historyTexts = reference.precedingUserPromptHashes ? userPromptTexts : userTexts;
      const [hashes, trailingHashes, candidateHash] = await Promise.all([
        Promise.all(historyTexts.slice(0, index + 1).map(hash)),
        Promise.all(userPromptTexts.slice(index + 1).map(hash)).catch(() => undefined),
        hash(candidateText),
      ]);
      const prefix = continuing || shiftedAnchor ? history.slice(history.length - index) : history;
      diagnostic.candidateHashMatches = candidateHash === reference.promptHash;
      diagnostic.prefixMatches = index <= reference.precedingUserHashes.length && prefix.length === index
        && prefix.every((value, position) => hashes[position] === value);
      if (trailingHashes) diagnostic.matchingPromptIndices = (visiblePromptHashes ?? [...hashes, ...trailingHashes])
        .flatMap((value, position) => (position === index ? candidateHash : value) === reference.promptHash ? [position] : []);
      if (binding!.invalidated || (generationState[generationKey] ?? 0) !== generation || binding!.url !== location.href || !anchor.isConnected
        || index > reference.precedingUserHashes.length || prefix.length !== index
        || candidateHash !== reference.promptHash || prefix.some((value, position) => hashes[position] !== value)) {
        discardBinding(binding);
        const reason = binding!.invalidated ? "binding-invalidated"
          : (generationState[generationKey] ?? 0) !== generation ? "preparation-changed"
          : binding!.url !== location.href ? "page-changed" : !anchor.isConnected ? "target-detached"
          : !diagnostic.prefixMatches ? "prefix-mismatch" : "prompt-mismatch";
        if (!diagnostic.candidateHashMatches) {
          try {
            const entries = Object.entries(variants);
            const [variantHashes, roleHashes, leafHashes, subtreeHashes] = await Promise.all([
              Promise.all(entries.map(([, text]) => hash(text))), Promise.all(roleTexts.map(hash)),
              Promise.all(leafSamples.map(hash)), Promise.all(subtreeSamples.map(sample => hash(sample.text))),
            ]);
            diagnostic.targetTextVariantMatches = {
              ...Object.fromEntries(entries.map(([name], position) => [name, variantHashes[position] === reference.promptHash])),
              userRoleText: roleHashes.some(value => value === reference.promptHash),
            } as MuseDeliveryDiagnostic["targetTextVariantMatches"];
            diagnostic.targetPlainLeafMatches = leafHashes.filter(value => value === reference.promptHash).length;
            const subtreeMatches = subtreeSamples.filter((_, index) => subtreeHashes[index] === reference.promptHash);
            diagnostic.targetSubtreeMatches = subtreeMatches.slice(0, 12).map(sample => sample.metadata);
            diagnostic.targetStructure = targetStructure;
            diagnostic.targetDiagnosticSample = {
              leafCount: leafTexts.length, sampledLeaves: leafSamples.length,
              subtreeCount: subtreeElements.length, sampledSubtrees: subtreeSamples.length,
              matchedSubtrees: subtreeMatches.length, structureTruncated,
            };
          } catch { /* Optional explanation must preserve the original result. */ }
        }
        return observation("missing", reason);
      }
      if (pageState[bindingKey] !== binding) { discardBinding(); pageState[bindingKey] = binding; }
    }
    const suffix = "[.!！。…\\s]*$";
    const failed = new RegExp("^(?:(?:消息)?(?:发送失败|發送失敗|未送达|未送達)|(?:message )?(?:send failed|sending failed|not delivered|failed to send|was not delivered|wasn't delivered))" + suffix, "i");
    const unconfirmed = new RegExp("^(?:(?:消息)?(?:未确认送达|未確認送達|仍在发送|仍在發送)|(?:message )?(?:delivery not confirmed|delivery unconfirmed|still sending))" + suffix, "i");
    const accepted = new RegExp("^(?:(?:消息)?(?:已送达|已送達|已发送|已發送|发送成功|發送成功)|(?:message )?(?:delivered|sent|successfully sent))" + suffix, "i");
    for (const message of labels) if (failed.test(message)) return observation("failed", "explicit-failure", [], message);
    for (const message of labels) if (unconfirmed.test(message)) {
      // The optimistic send badge can outlive the reply. A decoded result owned
      // by this verified turn proves receipt; uploads and other turns were
      // excluded above. Explicit delivery failures still take precedence.
      const stillSending = /^(?:message\s+)?(?:still sending|仍在发送|仍在發送)[.!！。…\s]*$/i.test(message);
      if (stillSending && media.some(item => item.width > 0 && item.height > 0))
        return observation("accepted", "assistant-content", media, message);
      return observation("unconfirmed", "delivery-unconfirmed", [], message);
    }
    for (const message of labels) if (accepted.test(message)) return observation("accepted", "explicit-acceptance", media, message);
    return observation(meaningfulAssistant ? "accepted" : "pending", meaningfulAssistant ? "assistant-content" : "no-assistant-content", media);
  } finally {
    // In particular, a rejected WebCrypto digest must not leave a provisional
    // document observer alive. Only one successfully verified binding survives.
    if (binding && pageState[bindingKey] !== binding) discardBinding(binding);
  }
}

export async function prepareMuseTurnAnchor(page: Page, prompt: string): Promise<MuseTurnAnchor> {
  const observation = await page.evaluate(observeMuseTurnInPage, { mode: "prepare" as const, prompt });
  return observation.anchor!;
}

export async function readMuseTurnSnapshot(page: Page, reference: MuseTurnReference): Promise<Observation> {
  return page.evaluate(observeMuseTurnInPage, { mode: "read" as const, reference });
}
