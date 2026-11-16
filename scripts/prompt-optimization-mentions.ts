import type { OptimizationContext } from "../src/prompt-optimization/types";

type Context = Pick<OptimizationContext, "prompt" | "mentions" | "references">;
type Mention = { marker: string; token: string; label: string; nodeId: string; count: number };
export type MentionRepair = { marker: string; kind: "marker-format" | "serialized-token" | "label" | "adjacent-duplicate" | "anchored-omission" };
export class ProtectedMentionError extends Error {}
export type MentionSegmentPlan = { segments: string[]; markers: string[] };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const occurrences = (text: string, part: string) => text.split(part).length - 1;
const nameKey = (value: string) => value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const underscore = String.raw`(?:\\?[_＿])`;
const markerPattern = new RegExp(`${underscore}{1,3}\\s*DRAW(?:${underscore}|\\s)+MENTION(?:${underscore}|\\s)+([0-9０-９]+)\\s*${underscore}{1,3}`, "gi");
const serializedPattern = /[@＠]\s*\[([^\]]*)\]\s*\(\s*draw-node\s*:\s*([^)]*?)\s*\)/gi;
const fail = (message: string): never => { throw new ProtectedMentionError(message + "，原提示词已保留。"); };
function boundedName(whole: string, offset: number, raw: string, label: string) {
  const previous = whole.slice(offset - 1, offset), next = whole.slice(offset + raw.length, offset + raw.length + 1);
  if (/[A-Za-z0-9_.+-]/.test(previous)) return false; // An email/identifier is not explicit reference syntax.
  return !(/[A-Za-z0-9_.-]/.test(next) || (/[\p{L}\p{N}]/u.test(next) && !/[0-9]$/.test(nameKey(label)) && !/[的中里上与和]/.test(next)));
}

function descriptors(context: Context): Mention[] {
  return Object.entries(context.mentions).flatMap(([marker, token]) => {
    const count = occurrences(context.prompt, marker);
    if (!count) return [];
    const parsed = /^@\[([^\]]*)\]\(draw-node:([^)]+)\)$/.exec(token);
    if (!parsed) return fail("原始素材引用格式无效");
    try { return [{ marker, token, count, label: decodeURIComponent(parsed[1]), nodeId: decodeURIComponent(parsed[2]) }]; }
    catch { return fail("原始素材引用编码无效"); }
  });
}

/** Find an omitted marker only at its original, uniquely preserved text boundary. */
function anchoredOmissions(output: string, original: string, marker: string) {
  const candidates = new Map<string, { start: number; end: number; text: string }>();
  for (const occurrence of original.matchAll(new RegExp(escape(marker), "g"))) {
    const before = original.slice(0, occurrence.index), after = original.slice(occurrence.index! + marker.length);
    const leftPadding = /\s*$/.exec(before)![0], rightPadding = /^\s*/.exec(after)![0];
    const left = before.trimEnd().slice(-40), right = after.trimStart().slice(0, 40);
    // Other protected markers are not prose anchors. Do not infer missing roles
    // from a sequence number or a neighboring reference alone.
    const meaningful = (value: string) => value.replace(/__DRAW_MENTION_\d+__/g, "").match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    let pattern: RegExp, boundary: "prefix" | "suffix" | "middle";
    if (!before.trim() && meaningful(right) >= 12 && !/__DRAW_MENTION_/.test(right)) {
      pattern = new RegExp("^(\\s*)" + escape(right), "g"); boundary = "prefix";
    } else if (!after.trim() && meaningful(left) >= 12 && !/__DRAW_MENTION_/.test(left)) {
      pattern = new RegExp(escape(left) + "(\\s*)$", "g"); boundary = "suffix";
    } else if (meaningful(left) >= 5 && meaningful(right) >= 5 && !/__DRAW_MENTION_/.test(left + right)) {
      pattern = new RegExp(escape(left) + "(\\s{0,8})" + escape(right), "g"); boundary = "middle";
    } else continue;
    const matches = [...output.matchAll(pattern)];
    if (matches.length !== 1) continue;
    const match = matches[0], gap = match[1];
    const start = match.index! + (boundary === "prefix" ? 0 : left.length);
    const end = start + gap.length;
    candidates.set(start + ":" + end, { start, end, text: leftPadding + marker + rightPadding });
  }
  return [...candidates.values()];
}

/**
 * Normalize only identities already present in the editable source. The repair
 * record contains marker IDs and categories, never pixels, credentials or prose.
 */
export function normalizeProtectedMentions(output: string, context: Context): { prompt: string; repairs: MentionRepair[] } {
  const known = descriptors(context), active = new Map(known.map(mention => [mention.marker, mention]));
  const repairs: MentionRepair[] = [];
  let prompt = output.replace(markerPattern, (raw, digits: string) => {
    const marker = "__DRAW_MENTION_" + digits.normalize("NFKC") + "__";
    if (!active.has(marker)) {
      // A user may discuss a literal reserved-looking string. It is not an asset.
      if (context.prompt.includes(raw) && occurrences(context.prompt, raw) >= occurrences(output, raw)) return raw;
      return fail("AI 返回了未知素材引用标记");
    }
    if (raw !== marker) repairs.push({ marker, kind: "marker-format" });
    return marker;
  });
  prompt = prompt.replace(serializedPattern, (_raw, encodedLabel: string, encodedId: string) => {
    let nodeId: string, label: string;
    try { nodeId = decodeURIComponent(encodedId.trim()); label = decodeURIComponent(encodedLabel); }
    catch { return fail("AI 返回的素材引用编码无效"); }
    const matches = known.filter(mention => mention.nodeId === nodeId);
    if (!matches.length) return fail("AI 返回了原文未使用的素材节点");
    const selected = matches.find(mention => mention.label === label) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!selected) return fail("AI 返回的素材节点存在多个原始引用，无法确定对应标签");
    repairs.push({ marker: selected.marker, kind: "serialized-token" }); return selected.marker;
  });
  if (/draw-node\s*:/i.test(prompt)) fail("AI 返回了无法解析的素材节点引用");

  const aliases = new Map<string, { labels: Set<string>; nodeIds: Set<string> }>();
  const addAlias = (label: string, nodeId: string) => {
    const key = nameKey(label); if (!key) return;
    const entry = aliases.get(key) ?? { labels: new Set<string>(), nodeIds: new Set<string>() };
    entry.labels.add(label); entry.nodeIds.add(nodeId); aliases.set(key, entry);
  };
  for (const mention of known) addAlias(mention.label, mention.nodeId);
  for (const reference of context.references) addAlias(reference.title, reference.nodeId);
  const names = [...aliases.values()].flatMap(entry => [...entry.labels]).sort((a, b) => nameKey(b).length - nameKey(a).length);
  if (names.length) {
    const namePattern = new RegExp("[@＠]\\s*(?:" + [...new Set(names.map(label => Array.from(label.replace(/\s+/gu, "")).map(escape).join("\\s*")))].join("|") + ")", "giu");
    // Mention chips were already replaced by markers in the source. Any plain
    // @name still present there is literal user prose (for example sign text),
    // so it cannot provide permission to create another bound mention.
    const literalNames = new Set([...context.prompt.matchAll(namePattern)].filter(match => boundedName(context.prompt, match.index!, match[0], match[0].replace(/^[@＠]\s*/, ""))).map(match => nameKey(match[0].replace(/^[@＠]\s*/, ""))));
    prompt = prompt.replace(namePattern, (raw, offset: number, whole: string) => {
      const label = raw.replace(/^[@＠]\s*/, ""), key = nameKey(label), entry = aliases.get(key);
      if (!entry || literalNames.has(key)) return raw;
      // Never bind a prefix of another identifier such as @图片10 or @portrait-v2.
      if (!boundedName(whole, offset, raw, label)) return raw;
      if (entry.nodeIds.size !== 1) return fail("AI 使用了重名素材标签，无法确定素材节点");
      const selected = known.filter(mention => entry.nodeIds.has(mention.nodeId));
      if (!selected.length) {
        if (context.prompt.includes(raw)) return raw;
        return fail("AI 引用了原文未使用的素材");
      }
      const preferred = selected.find(mention => nameKey(mention.label) === nameKey(label)) ?? (selected.length === 1 ? selected[0] : undefined);
      if (!preferred) return fail("AI 的素材标签无法唯一对应原始引用");
      repairs.push({ marker: preferred.marker, kind: "label" }); return preferred.marker;
    });
  }
  for (const mention of known) {
    // An adjacent echo contains no intervening prose or distinct role. Remove
    // only the surplus copies; separate uses still require the original count.
    let surplus = occurrences(prompt, mention.marker) - mention.count;
    if (surplus > 0) prompt = prompt.replace(new RegExp(escape(mention.marker) + "(?:[ \\t]+" + escape(mention.marker) + ")+", "g"), cluster => {
      const extra = Math.min(surplus, occurrences(cluster, mention.marker) - 1);
      surplus -= extra;
      for (let i = 0; i < extra; i++) repairs.push({ marker: mention.marker, kind: "adjacent-duplicate" });
      return Array(occurrences(cluster, mention.marker) - extra).fill(mention.marker).join(" ");
    });
    if (surplus > 0) fail("AI 重复了素材引用且改变了引用结构，无法可靠恢复");
  }
  // Missing occurrences need unique unchanged prose at the original boundary.
  // Never append a reference to the end merely because it was connected.
  let progress = true;
  while (progress) {
    progress = false;
    for (const mention of known) if (occurrences(prompt, mention.marker) < mention.count) {
      const candidates = anchoredOmissions(prompt, context.prompt, mention.marker);
      if (candidates.length === 1) {
        const insertion = candidates[0];
        prompt = prompt.slice(0, insertion.start) + insertion.text + prompt.slice(insertion.end);
        repairs.push({ marker: mention.marker, kind: "anchored-omission" }); progress = true;
      }
    }
  }
  for (const mention of known) if (occurrences(prompt, mention.marker) !== mention.count) fail("AI 遗漏了素材引用，且原文位置已改写，无法可靠恢复");
  return { prompt, repairs };
}

/** Reference occurrences are application-owned separators, including repeats. */
export function protectedMentionSegments(context: Context): MentionSegmentPlan {
  const active = new Set(descriptors(context).map(mention => mention.marker));
  const segments: string[] = [], markers: string[] = [];
  let offset = 0;
  for (const match of context.prompt.matchAll(/__DRAW_MENTION_\d+__/g)) if (active.has(match[0])) {
    segments.push(context.prompt.slice(offset, match.index)); markers.push(match[0]); offset = match.index! + match[0].length;
  }
  segments.push(context.prompt.slice(offset)); return { segments, markers };
}

/** Validate an internal JSON repair contract before restoring immutable gaps. */
export function rebuildProtectedMentionSegments(content: string, plan: MentionSegmentPlan): string {
  const text = content.trim().replace(/^```json\s*\n([\s\S]*)\n```$/i, "$1");
  let packet: unknown;
  try { packet = JSON.parse(text); } catch { return fail("AI 的引用结构修复未返回合法 JSON"); }
  if (!packet || typeof packet !== "object" || Array.isArray(packet) || Object.keys(packet).length !== 1 || !("segments" in packet)) return fail("AI 的引用结构修复格式不正确");
  const segments = (packet as { segments: unknown }).segments;
  if (!Array.isArray(segments) || segments.length !== plan.segments.length) return fail("AI 的引用结构修复文本段数量不正确");
  let total = plan.markers.join("").length;
  const restored = segments.map((segment, index) => {
    if (typeof segment !== "string" || segment.length > 100000) return fail("AI 的引用结构修复文本段类型或长度不正确");
    total += segment.length;
    if (total > 100000) return fail("AI 的引用结构修复结果超过长度限制");
    if (/draw-node\s*:/i.test(segment) || /(?:\\?[_＿])+\s*DRAW(?:\\?[_＿]|\s)+MENTION/i.test(segment)) return fail("AI 在引用结构修复文本中写入了素材标记");
    const original = plan.segments[index];
    if (original.trim() && !segment.trim()) return fail("AI 删除了引用之间的原始文本段");
    if (!original.trim() && segment.trim()) return fail("AI 在原本空白的引用边界增加了正文");
    for (const mention of segment.matchAll(/[@＠]\s*[^\s，。；！？、,;!?“”"'<>]+/gu)) {
      if (!original.includes(mention[0])) return fail("AI 在引用结构修复文本中加入了新的 @ 引用");
    }
    return original.trim() ? segment : original;
  });
  return restored.map((segment, index) => segment + (plan.markers[index] ?? "")).join("");
}

/** Candidate prose is untrusted; application IDs are unnecessary in repair input. */
export function mentionRepairCandidate(candidate: string, context: Context): string {
  const known = new Map(descriptors(context).map(mention => [mention.marker, mention.label]));
  return candidate.replace(markerPattern, (_raw, digits: string) => "[" + (known.get("__DRAW_MENTION_" + digits.normalize("NFKC") + "__") ?? "unverified reference") + "]")
    .replace(serializedPattern, (_raw, label: string) => { try { return "[" + decodeURIComponent(label) + "]"; } catch { return "[unverified reference]"; } });
}
