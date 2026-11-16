import type { Asset, Canvas, CanvasNode, MediaKind } from "../types";

export type PromptMention = { nodeId: string; label: string; token: string };
export type PromptPart =
  { type: "text"; text: string } | ({ type: "mention" } & PromptMention);
export type PromptMentionCandidate = {
  nodeId: string;
  label: string;
  kind: MediaKind;
  asset?: Asset;
  available: boolean;
  status: string;
};

// Escape every delimiter so labels and imported node IDs cannot change token structure.
function encodeComponent(value: string) {
  const wellFormed = Array.from(value, (character) =>
    /^[\uD800-\uDFFF]$/.test(character) ? "\uFFFD" : character,
  ).join("");
  return encodeURIComponent(wellFormed).replace(
    /[!'()*]/g,
    (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function encodePromptMention(nodeId: string, label: string): string {
  if (!nodeId) throw new Error("素材节点标识不能为空。");
  return (
    "@[" +
    encodeComponent(label.trim() || "素材") +
    "](draw-node:" +
    encodeComponent(nodeId) +
    ")"
  );
}

/** Plain @ text and malformed tokens stay plain text; saved mentions are explicit. */
export function parsePromptMentions(value: string): PromptPart[] {
  const parts: PromptPart[] = [];
  const tokenPattern =
    /@\[((?:[A-Za-z0-9_.~-]|%[0-9a-fA-F]{2})*)\]\(draw-node:((?:[A-Za-z0-9_.~-]|%[0-9a-fA-F]{2})+)\)/g;
  let offset = 0;
  for (const match of value.matchAll(tokenPattern)) {
    let label: string, nodeId: string;
    try {
      label = decodeURIComponent(match[1]);
      nodeId = decodeURIComponent(match[2]);
    } catch {
      continue;
    }
    if (match.index > offset)
      parts.push({ type: "text", text: value.slice(offset, match.index) });
    parts.push({ type: "mention", nodeId, label, token: match[0] });
    offset = match.index + match[0].length;
  }
  if (offset < value.length)
    parts.push({ type: "text", text: value.slice(offset) });
  return parts;
}

function connectedSources(canvas: Canvas, targetNodeId: string): CanvasNode[] {
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  return canvas.edges
    .filter((edge) => edge.target === targetNodeId)
    .sort((a, b) => (a.data?.order ?? 0) - (b.data?.order ?? 0))
    .flatMap((edge) => {
      const source = nodes.get(edge.source);
      if (!source || source.data.kind === "group" || seen.has(source.id))
        return [];
      seen.add(source.id);
      return [source];
    });
}

export function resolvePromptMentions(
  value: string,
  canvas: Canvas,
  targetNodeId: string,
): {
  text: string;
  missingMentions: PromptMention[];
} {
  const sources = new Map(
    connectedSources(canvas, targetNodeId).map((node) => [node.id, node]),
  );
  const missing = new Map<string, PromptMention>();
  const text = parsePromptMentions(value)
    .map((part) => {
      if (part.type === "text") return part.text;
      const source = sources.get(part.nodeId);
      if (!source)
        missing.set(part.nodeId, {
          nodeId: part.nodeId,
          label: part.label,
          token: part.token,
        });
      return "@" + (source?.data.title.trim() || part.label || "素材");
    })
    .join("");
  return { text, missingMentions: [...missing.values()] };
}

/** Copying a connected selection binds mentions to its new source nodes. */
export function remapPromptMentions(
  value: string,
  ids: ReadonlyMap<string, string>,
): string {
  return parsePromptMentions(value)
    .map((part) =>
      part.type === "text"
        ? part.text
        : ids.has(part.nodeId)
          ? encodePromptMention(ids.get(part.nodeId)!, part.label)
          : part.token,
    )
    .join("");
}

export function getPromptMentionCandidates(
  canvas: Canvas,
  targetNodeId: string,
  assets: Record<string, Asset>,
): PromptMentionCandidate[] {
  const kindNames: Record<MediaKind, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    text: "文本",
    file: "素材",
  };
  const counts: Record<MediaKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
    text: 0,
    file: 0,
  };
  return connectedSources(canvas, targetNodeId).map((source) => {
    const asset = source.data.assetId ? assets[source.data.assetId] : undefined;
    const textSource =
      source.data.kind === "text" ||
      (source.data.kind === "tool" && source.data.text !== undefined);
    const kind: MediaKind = textSource
      ? "text"
      : (asset?.kind ??
        (source.data.kind === "video"
          ? "video"
          : source.data.kind === "audio"
            ? "audio"
            : source.data.kind === "tool"
              ? "file"
              : "image"));
    counts[kind]++;
    const label = source.data.title.trim() || kindNames[kind] + counts[kind];
    const available = textSource ? !!source.data.text?.trim() : !!asset;
    const status = available
      ? "已连接"
      : textSource
        ? "文本为空"
        : source.data.generation
          ? "等待上游生成"
          : "等待上传素材";
    return { nodeId: source.id, label, kind, asset, available, status };
  });
}
