import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Clapperboard,
  File,
  ImageIcon,
  Music2,
  NotebookText,
} from "lucide-react";
import { acquireAssetUrl } from "../assets/assets";
import { AssetPreview } from "../assets/AssetPreview";
import type { Asset } from "../types";
import {
  encodePromptMention,
  parsePromptMentions,
  type PromptMentionCandidate,
} from "../semantic/mentions";
import {
  serializePromptDocument,
  type PromptDocumentNode,
} from "./prompt-document";
import "./prompt-mentions.css";

const clipboardType = "application/x-draw-studio-prompt";
const blockTags = new Set(["DIV", "P", "LI"]);

/** Chips are atomic values. Browser-created line wrappers must remain plain text. */
export function readPromptEditor(root: Node, trimPlaceholder = true): string {
  const read = (node: Node): PromptDocumentNode => {
    if (node.nodeType === Node.TEXT_NODE)
      return { type: "text", text: node.textContent ?? "" };
    if (node instanceof HTMLElement) {
      if (node.dataset.promptMention)
        return { type: "mention", token: node.dataset.promptMention };
      if (node.tagName === "BR") return { type: "break" };
    }
    return {
      type: "element",
      block: node instanceof HTMLElement && blockTags.has(node.tagName),
      children: Array.from(node.childNodes, read),
    };
  };
  return serializePromptDocument(read(root), trimPlaceholder);
}

function mediaIcon(kind: PromptMentionCandidate["kind"]) {
  return kind === "video"
    ? Clapperboard
    : kind === "audio"
      ? Music2
      : kind === "text"
        ? NotebookText
        : kind === "file"
          ? File
          : ImageIcon;
}

function previewIcon(kind: PromptMentionCandidate["kind"]) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  const paths =
    kind === "audio"
      ? ["M9 18V5l12-2v13", "M9 18a3 3 0 1 1-3-3h3", "M21 16a3 3 0 1 1-3-3h3"]
      : kind === "video"
        ? ["M3 8h18v12H3z", "M3 8V4h18v4", "m7 4 3 4m5-4 3 4"]
        : kind === "text"
          ? ["M5 3h14v18H5z", "M9 8h6M9 12h6M9 16h4"]
          : kind === "file"
            ? ["M14 2H6v20h12V6z", "M14 2v5h5"]
            : ["M3 3h18v18H3z", "m3 17 6-6 4 4 3-3 5 5", "M8 7h.01"];
  for (const d of paths) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function paintChip(
  chip: HTMLElement,
  candidates: PromptMentionCandidate[],
  urls: Record<string, string>,
) {
  const mention = parsePromptMentions(chip.dataset.promptMention ?? "")[0];
  if (mention?.type !== "mention") return;
  const candidate = candidates.find((item) => item.nodeId === mention.nodeId);
  const label = candidate?.label ?? mention.label;
  const paintKey = JSON.stringify([
    label,
    candidate?.available,
    candidate?.status,
    candidate?.kind,
    candidate?.asset?.id,
    candidate?.asset && urls[candidate.asset.id],
  ]);
  if (chip.dataset.paintKey === paintKey && chip.children.length) return;
  chip.dataset.paintKey = paintKey;
  chip.className =
    "prompt-mention" + (!candidate?.available ? " unavailable" : "");
  chip.contentEditable = "false";
  chip.setAttribute(
    "aria-label",
    "引用素材：@" +
      label +
      (!candidate?.available
        ? "（" + (candidate?.status ?? "已断开连接") + "）"
        : ""),
  );
  chip.title = candidate?.available
    ? "@" + label
    : label + " · " + (candidate?.status ?? "已断开连接，请重新连接素材");
  const preview = document.createElement("span");
  preview.className = "prompt-mention-preview";
  preview.setAttribute("aria-hidden", "true");
  preview.append(previewIcon(candidate?.kind ?? "image"));
  if (candidate?.kind === "video" && candidate.asset)
    preview.dataset.videoAssetId = candidate.asset.id;
  const url = candidate?.asset && urls[candidate.asset.id];
  if (url && candidate.kind === "image") {
    const media = document.createElement("img");
    media.src = url;
    media.draggable = false;
    media.alt = "";
    media.onerror = () => {
      media.style.visibility = "hidden";
    };
    preview.append(media);
  }
  const text = document.createElement("span");
  text.className = "prompt-mention-label";
  text.textContent = "@" + label;
  chip.replaceChildren(preview, text);
}

function promptFragment(
  value: string,
  candidates: PromptMentionCandidate[],
  urls: Record<string, string>,
) {
  const fragment = document.createDocumentFragment();
  for (const part of parsePromptMentions(value)) {
    if (part.type === "text") {
      const lines = part.text.split("\n");
      lines.forEach((line, index) => {
        if (index) fragment.append(document.createElement("br"));
        if (line) fragment.append(document.createTextNode(line));
      });
    } else {
      const chip = document.createElement("span");
      chip.dataset.promptMention = part.token;
      paintChip(chip, candidates, urls);
      fragment.append(chip);
    }
  }
  if (value.endsWith("\n")) fragment.append(document.createElement("br"));
  return fragment;
}

type MentionQuery = { text: string; range: Range; key: string };
type VideoChipPreview = { container: HTMLElement; asset: Asset };

export function PromptEditor({
  value,
  candidates,
  disabled,
  placeholder,
  onChange,
  onSubmit,
}: {
  value: string;
  candidates: PromptMentionCandidate[];
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const dismissed = useRef("");
  const callbacks = useRef({ onChange, candidates, disabled });
  callbacks.current = { onChange, candidates, disabled };
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [videoPreviews, setVideoPreviews] = useState<VideoChipPreview[]>([]);
  const videoPreviewContainers = useRef(new Set<HTMLElement>());
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 240,
    maxHeight: 240,
  });
  const menuId = useId();
  const assetKey = JSON.stringify(
    candidates.flatMap((item) =>
      item.asset && item.kind === "image"
        ? [item.asset.id]
        : [],
    ),
  );
  useEffect(() => {
    let active = true;
    const releases: (() => void)[] = [];
    setUrls({});
    const assets = [
      ...new Map(
        callbacks.current.candidates.flatMap((item) =>
          item.asset && item.kind === "image"
            ? [[item.asset.id, item.asset] as const]
            : [],
        ),
      ).values(),
    ];
    for (const asset of assets)
      void acquireAssetUrl(asset)
        .then((item) => {
          if (!active) {
            item.release();
            return;
          }
          releases.push(item.release);
          setUrls((current) => ({ ...current, [asset.id]: item.url }));
        })
        .catch(() => {});
    return () => {
      active = false;
      for (const release of releases) release();
    };
  }, [assetKey]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || composing.current) return;
    if (readPromptEditor(editor) !== value) {
      editor.replaceChildren(promptFragment(value, candidates, urls));
      setQuery(null);
    } else
      for (const chip of editor.querySelectorAll<HTMLElement>(
        "[data-prompt-mention]",
      ))
        paintChip(chip, candidates, urls);
    const videoAssets = new Map(candidates.flatMap(candidate =>
      candidate.kind === "video" && candidate.asset ? [[candidate.asset.id, candidate.asset] as const] : []));
    const previews = [...editor.querySelectorAll<HTMLElement>(".prompt-mention-preview[data-video-asset-id]")]
      .flatMap(container => {
        const asset = videoAssets.get(container.dataset.videoAssetId!);
        if (!asset) return [];
        if (!videoPreviewContainers.current.has(container)) {
          // Native undo and paste can restore cloned portal children. Replace
          // those unmanaged media nodes before this React tree takes ownership.
          for (const video of container.querySelectorAll("video")) {
            video.pause();
            video.removeAttribute("src");
            video.load();
          }
          container.replaceChildren(previewIcon("video"));
        }
        return [{ container, asset }];
      });
    videoPreviewContainers.current = new Set(previews.map(preview => preview.container));
    setVideoPreviews(current => current.length === previews.length && current.every((preview, index) =>
      preview.container === previews[index].container && preview.asset === previews[index].asset) ? current : previews);
  }, [value, candidates, urls]);

  const refreshQuery = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (
      !editor ||
      callbacks.current.disabled ||
      composing.current ||
      document.activeElement !== editor ||
      !selection?.isCollapsed ||
      !selection.rangeCount
    ) {
      setQuery(null);
      return;
    }
    const caret = selection.getRangeAt(0);
    if (
      !editor.contains(caret.startContainer) ||
      caret.startContainer.nodeType !== Node.TEXT_NODE ||
      caret.startContainer.parentElement?.closest("[data-prompt-mention]")
    ) {
      setQuery(null);
      return;
    }
    const prefix = (caret.startContainer.textContent ?? "").slice(
      0,
      caret.startOffset,
    );
    const match = /@([^@\s]{0,60})$/u.exec(prefix);
    if (!match) {
      dismissed.current = "";
      setQuery(null);
      return;
    }
    const range = caret.cloneRange();
    range.setStart(caret.startContainer, match.index);
    const key = prefix + ":" + caret.startOffset;
    if (dismissed.current === key) {
      setQuery(null);
      return;
    }
    if (query?.key !== key) setHighlight(0);
    setQuery({ text: match[1], range, key });
  };
  const refresh = useRef(refreshQuery);
  refresh.current = refreshQuery;
  useEffect(() => {
    const selectionChanged = () => refresh.current();
    document.addEventListener("selectionchange", selectionChanged);
    return () =>
      document.removeEventListener("selectionchange", selectionChanged);
  }, []);
  useEffect(() => {
    if (disabled) setQuery(null);
  }, [disabled]);

  const filtered = candidates.filter(
    (item) =>
      !query?.text ||
      (item.label + " " + (item.asset?.name ?? ""))
        .toLocaleLowerCase()
        .includes(query.text.toLocaleLowerCase()),
  );
  const available = filtered.filter((item) => item.available);
  const active =
    available[Math.min(highlight, Math.max(0, available.length - 1))];
  useLayoutEffect(() => {
    if (!query) return;
    const place = () => {
      const editor = editorRef.current;
      if (!editor) return;
      const bounds = editor.getBoundingClientRect();
      const caret = query.range.getBoundingClientRect();
      const width = Math.min(240, window.innerWidth - 24);
      const bottom = caret.height ? caret.bottom : bounds.top + 30;
      const top = caret.height ? caret.top : bounds.top;
      const below = window.innerHeight - bottom - 16;
      const above = top - 16;
      const contentHeight = filtered.length
        ? 14 + filtered.length * 48 + Math.max(0, filtered.length - 1) * 3
        : 54;
      const desiredHeight = Math.min(240, contentHeight);
      const placeAbove = below < Math.min(180, desiredHeight) && above > below;
      const height = Math.min(
        desiredHeight,
        Math.max(44, placeAbove ? above : below),
      );
      const next = {
        left: Math.max(
          12,
          Math.min(
            caret.width || caret.height ? caret.left : bounds.left,
            window.innerWidth - width - 12,
          ),
        ),
        top:
          placeAbove
            ? Math.max(12, top - height - 6)
            : bottom + 6,
        width,
        maxHeight: height,
      };
      setPosition((current) =>
        current.left === next.left &&
        current.top === next.top &&
        current.width === next.width &&
        current.maxHeight === next.maxHeight
          ? current
          : next,
      );
    };
    // The floating panel also follows canvas pan/zoom, which produces no DOM scroll event.
    let frame = 0;
    const follow = () => {
      place();
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [query, filtered.length]);
  useEffect(() => {
    if (query && active)
      document
        .getElementById(menuId + "-" + active.nodeId)
        ?.scrollIntoView({ block: "nearest" });
  }, [query?.text, active?.nodeId, menuId]);

  const commit = () => {
    if (!composing.current && editorRef.current)
      callbacks.current.onChange(readPromptEditor(editorRef.current));
    refresh.current();
  };
  const insert = (candidate: PromptMentionCandidate) => {
    const editor = editorRef.current;
    if (
      !editor ||
      !query ||
      disabled ||
      !candidate.available ||
      !editor.contains(query.range.startContainer) ||
      !editor.contains(query.range.endContainer)
    )
      return;
    editor.focus();
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(query.range);
    const holder = document.createElement("div");
    holder.append(
      promptFragment(
        encodePromptMention(candidate.nodeId, candidate.label),
        candidates,
        urls,
      ),
    );
    // Native insertion keeps text and atomic tags in the same browser undo stack.
    document.execCommand("insertHTML", false, holder.innerHTML + "&nbsp;");
    dismissed.current = "";
    setQuery(null);
    commit();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      disabled ||
      composing.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      setQuery(null);
      onSubmit();
      return;
    }
    if (query) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissed.current = query.key;
        setQuery(null);
        return;
      }
      if (
        available.length &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        event.preventDefault();
        setHighlight(
          (current) =>
            (current +
              (event.key === "ArrowDown" ? 1 : -1) +
              available.length) %
            available.length,
        );
        return;
      }
      if (active && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        insert(active);
        return;
      }
    }
    if (event.key === "Enter") {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      commit();
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      ["b", "i", "u"].includes(event.key.toLowerCase())
    )
      event.preventDefault();
  };
  const copy = (event: ClipboardEvent<HTMLDivElement>, cut = false) => {
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (
      !editor ||
      !selection?.rangeCount ||
      selection.isCollapsed ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    )
      return;
    const range = selection.getRangeAt(0);
    const suffix = document.createRange();
    suffix.selectNodeContents(editor);
    suffix.setStart(range.endContainer, range.endOffset);
    const remaining = suffix.cloneContents();
    const atEnd =
      !remaining.textContent &&
      !remaining.querySelector("br,[data-prompt-mention]");
    const serialized = readPromptEditor(range.cloneContents(), atEnd);
    const text = parsePromptMentions(serialized)
      .map((part) =>
        part.type === "text"
          ? part.text
          : "@" +
            (candidates.find((item) => item.nodeId === part.nodeId)?.label ??
              part.label),
      )
      .join("");
    event.preventDefault();
    event.clipboardData.setData("text/plain", text);
    event.clipboardData.setData(clipboardType, serialized);
    if (cut && !disabled) {
      document.execCommand("delete");
      commit();
    }
  };
  return (
    <>
      <div
        ref={editorRef}
        className="prompt prompt-editor"
        role="textbox"
        aria-label="提示词"
        aria-multiline="true"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={query ? menuId : undefined}
        aria-activedescendant={
          query && active ? menuId + "-" + active.nodeId : undefined
        }
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        data-placeholder={placeholder}
        data-empty={!value}
        spellCheck={false}
        onInput={() => {
          dismissed.current = "";
          commit();
        }}
        onKeyDown={keyDown}
        onClick={refreshQuery}
        onBlur={() => setQuery(null)}
        onCompositionStart={() => {
          composing.current = true;
          setQuery(null);
        }}
        onCompositionEnd={() => {
          composing.current = false;
          commit();
        }}
        onCopy={(event) => copy(event)}
        onCut={(event) => copy(event, true)}
        onPaste={(event) => {
          event.preventDefault();
          if (disabled) return;
          const text =
            event.clipboardData.getData(clipboardType) ||
            event.clipboardData.getData("text/plain");
          const holder = document.createElement("div");
          holder.append(
            promptFragment(text.replace(/\r\n?/g, "\n"), candidates, urls),
          );
          document.execCommand("insertHTML", false, holder.innerHTML);
          commit();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      />
      {videoPreviews.map(({ container, asset }, index) =>
        createPortal(<AssetPreview asset={asset} />, container, asset.id + ":" + index))}
      {query &&
        createPortal(
          <div
            className="prompt-mention-menu nodrag nopan nowheel"
            style={position}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onWheel={(event) => event.stopPropagation()}
          >
            <div
              role="listbox"
              id={menuId}
              aria-label="已连接素材"
              className="prompt-mention-options"
            >
              {filtered.map((item) => {
                const Icon = mediaIcon(item.kind);
                const url = item.asset && urls[item.asset.id];
                return (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    id={menuId + "-" + item.nodeId}
                    key={item.nodeId}
                    aria-selected={active?.nodeId === item.nodeId}
                    aria-disabled={!item.available}
                    aria-label={
                      item.available
                        ? item.label
                        : item.label + "（" + item.status + "）"
                    }
                    title={
                      item.available
                        ? item.label
                        : item.label + " · " + item.status
                    }
                    className={
                      "prompt-mention-option" +
                      (active?.nodeId === item.nodeId ? " active" : "")
                    }
                    onMouseEnter={() => {
                      const index = available.indexOf(item);
                      if (index >= 0) setHighlight(index);
                    }}
                    onClick={() => insert(item)}
                  >
                    <span className="prompt-mention-preview" aria-hidden="true">
                      <Icon size={18} />
                      {url && item.kind === "image" && (
                        <img
                          src={url}
                          alt=""
                          draggable={false}
                          onError={(event) => {
                            event.currentTarget.style.visibility = "hidden";
                          }}
                        />
                      )}
                      {item.kind === "video" && item.asset && <AssetPreview asset={item.asset} />}
                    </span>
                    <span className="prompt-mention-option-label">
                      {item.label}
                    </span>
                  </button>
                );
              })}
              {!filtered.length && (
                <p className="prompt-mention-empty">
                  {candidates.length
                    ? "没有匹配的素材"
                    : "请先连接素材"}
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
