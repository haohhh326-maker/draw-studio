import { describe, expect, it } from "vitest";
import { normalizeProtectedMentions, protectedMentionSegments, rebuildProtectedMentionSegments } from "../scripts/prompt-optimization-mentions";
import { encodePromptMention } from "../src/semantic/mentions";
import type { OptimizationContext } from "../src/prompt-optimization/types";

const first = "__DRAW_MENTION_0__", second = "__DRAW_MENTION_1__";
function context(prompt = `使用 ${first} 的人物。`): Pick<OptimizationContext, "prompt" | "mentions" | "references"> {
  return { prompt, mentions: { [first]: encodePromptMention("node-one", "图片1") }, references: [
    { nodeId: "node-one", edgeId: "edge-one", title: "图片1", kind: "image", role: "character", roleLabel: "人物参考" },
  ] };
}

describe("deterministic protected mention recovery", () => {
  it("retains the existing character bound for repaired output segments", () => {
    const plan = protectedMentionSegments(context(`使用 ${first} 的人物。`));
    const prefix = "a".repeat(100001), suffix = " 的人物保持一致。";
    expect(() => rebuildProtectedMentionSegments(JSON.stringify({ segments: [prefix, suffix] }), plan)).toThrow("文本段类型或长度不正确");
  });
  it("retains the existing total character bound when a context capacity setting is added", () => {
    const plan = protectedMentionSegments(context(`使用 ${first} 的人物。`)), segment = "a".repeat(50000);
    expect(() => rebuildProtectedMentionSegments(JSON.stringify({ segments: [segment, segment] }), plan)).toThrow("结果超过长度限制");
  });
  it.each(["_DRAW_MENTION_0_", "__draw_mention_0__", "__ DRAW _ MENTION _ 0 __", "＿＿DRAW＿MENTION＿０＿＿", String.raw`\_\_DRAW\_MENTION\_0\_\_`])("normalizes a known marker's formatting without changing its identity: %s", variant => {
    const data = context(); const result = normalizeProtectedMentions(`保持 ${variant} 的人物和衣服。`, data);
    expect(result.prompt).toBe(`保持 ${first} 的人物和衣服。`);
    expect(result.repairs).toEqual([{ marker: first, kind: "marker-format" }]);
  });
  it("accepts canonical markers unchanged and records no recovery", () => {
    expect(normalizeProtectedMentions(`保持 ${first} 的人物。`, context())).toEqual({ prompt: `保持 ${first} 的人物。`, repairs: [] });
  });
  it.each(["@图片1的人物，向前走。", "＠ 图片 1 的人物，向前走。"])("restores an explicit unique name to the original node: %s", output => {
    const result = normalizeProtectedMentions(output, context());
    expect(result.prompt).toContain(first); expect(result.prompt).not.toContain("@图片");
    expect(result.repairs).toEqual([{ marker: first, kind: "label" }]);
  });
  it("recognizes a renamed node's current title without using connection order", () => {
    const data = context(); data.references[0].title = "人物 A";
    expect(normalizeProtectedMentions("@人物 A 的服装保持不变。", data).prompt).toBe(first + " 的服装保持不变。");
  });
  it("preserves literal on-image @text instead of binding it to a material node", () => {
    const data = context(`保留 ${first} 的人物，招牌上写着“@图片1”。`);
    const output = `保留 ${first} 的人物身份，招牌上写着“@图片1”。`;
    expect(normalizeProtectedMentions(output, data).prompt).toBe(output);
    expect(() => normalizeProtectedMentions("保留@图片1的人物，招牌上写着“@图片1”。", data)).toThrow("遗漏了素材引用");
  });
  it("normalizes an English label's case while keeping unrelated email text unchanged", () => {
    const data = context(); data.mentions[first] = encodePromptMention("node-one", "Portrait1"); data.references[0].title = "Portrait1";
    const result = normalizeProtectedMentions("Use @PORTRAIT1, keep the sign user@example.com.", data);
    expect(result.prompt).toBe(`Use ${first}, keep the sign user@example.com.`);
    expect(() => normalizeProtectedMentions("Keep user@Portrait1 on the sign.", data)).toThrow("遗漏了素材引用");
  });
  it("restores an application's serialized token by its decoded node identity", () => {
    const data = context(); data.mentions[first] = encodePromptMention("a/(b)", "人物 (正面)");
    data.references[0].nodeId = "a/(b)"; data.references[0].title = "人物 (正面)";
    const returned = "@[修改了显示标签](draw-node:a%2F%28b%29) 站在街道上。";
    expect(normalizeProtectedMentions(returned, data).prompt).toBe(first + " 站在街道上。");
  });
  it("keeps separate character and style bindings rather than assigning them by output order", () => {
    const data = context(`使用 ${first} 的人物，采用 ${second} 的风格。`);
    data.mentions[second] = encodePromptMention("node-two", "风格参考");
    data.references.push({ nodeId: "node-two", edgeId: "edge-two", title: "风格参考", kind: "image", role: "style", roleLabel: "风格参考" });
    expect(normalizeProtectedMentions("采用@风格参考的色调，保持@图片1的人物身份。", data).prompt).toBe(`采用${second}的色调，保持${first}的人物身份。`);
  });
  it("does not guess that plain prose or a longer identifier is a protected mention", () => {
    for (const output of ["图片1的人物保持原样。", "@图片10的人物保持原样。", "@图片1-v2的人物保持原样。"])
      expect(() => normalizeProtectedMentions(output, context())).toThrow("遗漏了素材引用");
  });
  it("rejects ambiguous names even when only one of the same-name nodes was used originally", () => {
    const data = context(); data.references.push({ nodeId: "other", edgeId: "e2", title: "图片1", kind: "image", role: "style", roleLabel: "风格" });
    expect(() => normalizeProtectedMentions("@图片1的人物保持原样。", data)).toThrow("重名素材标签");
    expect(normalizeProtectedMentions(first + " 的人物保持原样。", data).prompt).toContain(first);
  });
  it("rejects unknown markers and nodes, including connected materials that the source did not mention", () => {
    const data = context(); data.references.push({ nodeId: "unused", edgeId: "e2", title: "图片2", kind: "image", role: "reference", roleLabel: "参考" });
    for (const output of [first + " " + second, first + " " + String.raw`\_\_DRAW\_MENTION\_99\_\_`, first + " " + encodePromptMention("unused", "图片2"), first + " @图片2"])
      expect(() => normalizeProtectedMentions(output, data)).toThrow(/未知|原文未使用/);
  });
  it("does not treat an unused mention-map entry as permission to create a reference", () => {
    const data = context(); data.mentions[second] = encodePromptMention("unused", "图片2");
    expect(() => normalizeProtectedMentions(first + " " + second, data)).toThrow("未知素材引用");
  });
  it("removes only surplus adjacent echoes and preserves non-adjacent reference roles", () => {
    const output = `保持 ${first} ${first} 的服装。`;
    expect(normalizeProtectedMentions(output, context())).toEqual({ prompt: `保持 ${first} 的服装。`, repairs: [{ marker: first, kind: "adjacent-duplicate" }] });
    expect(() => normalizeProtectedMentions(`保持 ${first} 的服装，采用 ${first} 的背景。`, context())).toThrow("重复了素材引用且改变了引用结构");
  });
  it("does not collapse two original uses of the same material when their roles cannot be recovered", () => {
    const data = context(`使用 ${first} 的人物；采用 ${first} 的服装。`);
    expect(() => normalizeProtectedMentions(`使用 ${first} 的人物和服装。`, data)).toThrow("遗漏了素材引用");
  });
  it("recovers an omitted leading reference only at a sufficiently long unchanged source prefix", () => {
    const prose = "人物沿着清晨安静的街道缓慢向前行走。";
    const result = normalizeProtectedMentions(prose + "镜头保持平稳。", context(first + " " + prose));
    expect(result.prompt).toBe(first + " " + prose + "镜头保持平稳。");
    expect(result.repairs).toEqual([{ marker: first, kind: "anchored-omission" }]);
  });
  it("recovers an omitted middle reference at a unique unchanged two-sided boundary", () => {
    const left = "保持所有主体的位置和环境关系 ", right = " 中指定的衣服颜色和纹理完全一致。";
    const result = normalizeProtectedMentions(left + right, context(left + first + right));
    expect(result.prompt).toBe(left + first + right);
  });
  it("refuses short, repeated, shifted or rewritten anchors instead of appending missing references", () => {
    const short = context(first + " 人物向前走。");
    expect(() => normalizeProtectedMentions("人物向前走。", short)).toThrow("无法可靠恢复");
    const long = "人物沿着清晨安静的街道缓慢向前行走。";
    expect(() => normalizeProtectedMentions("镜头开始移动。" + long, context(first + " " + long))).toThrow("无法可靠恢复");
    const left = "保持所有主体的位置和环境关系 ", right = " 中指定的衣服颜色和纹理完全一致。";
    expect(() => normalizeProtectedMentions((left + right).repeat(2), context(left + first + right))).toThrow("无法可靠恢复");
  });
  it("preserves a literal marker-looking source string without binding it to a node", () => {
    const data = context("解释 __DRAW_MENTION_99__ 的作用。"); data.mentions = {};
    expect(normalizeProtectedMentions(data.prompt, data).prompt).toBe(data.prompt);
    expect(() => normalizeProtectedMentions(data.prompt + " __DRAW_MENTION_99__", data)).toThrow("未知素材引用");
    const escaped = { ...data, prompt: String.raw`解释 \_\_DRAW\_MENTION\_99\_\_ 的作用。` };
    expect(normalizeProtectedMentions(escaped.prompt, escaped).prompt).toBe(escaped.prompt);
  });
});

describe("application-owned segment repair", () => {
  const data = () => {
    const value = context(`让 ${first} 的人物保持动作，采用 ${second} 的服装。`);
    value.mentions[second] = encodePromptMention("node-two", "图片2"); return value;
  };
  it("splits every occurrence, including repeats, and restores original identities only between corresponding segments", () => {
    const source = data(); source.prompt = first + " 的人物参考 " + first + "，衣服参考 " + second;
    const plan = protectedMentionSegments(source);
    expect(plan).toEqual({ markers: [first, first, second], segments: ["", " 的人物参考 ", "，衣服参考 ", ""] });
    expect(rebuildProtectedMentionSegments(JSON.stringify({ segments: ["", " 的人物身份保持一致，使用 ", "，服装保持 ", ""] }), plan)).toBe(`${first} 的人物身份保持一致，使用 ${first}，服装保持 ${second}`);
  });
  it.each([
    "not JSON",
    JSON.stringify({ segments: ["只有一段"] }),
    JSON.stringify({ segments: ["让", null, "的服装"] }),
    JSON.stringify({ segments: ["让", "的人物", "的服装"], prompt: "extra field" }),
    JSON.stringify({ segments: ["让", " ", "的服装"] }),
    JSON.stringify({ segments: ["所有正文放在开头", "", ""] }),
    JSON.stringify({ segments: ["让", first + " 的人物", "的服装"] }),
    JSON.stringify({ segments: ["让", String.raw`\_\_DRAW\_MENTION\_0\_\_`, "的服装"] }),
    JSON.stringify({ segments: ["让", "@[新素材](draw-node:unknown)", "的服装"] }),
    JSON.stringify({ segments: ["让", "参考@图片99", "的服装"] }),
  ])("rejects invalid or structurally destructive repair output without moving references: %s", content => {
    expect(() => rebuildProtectedMentionSegments(content, protectedMentionSegments(data()))).toThrow();
  });
  it("keeps originally empty boundaries empty instead of moving all text ahead of the references", () => {
    const plan = protectedMentionSegments(context(first + " 的人物"));
    expect(() => rebuildProtectedMentionSegments(JSON.stringify({ segments: ["把所有正文写在这里", "的人物"] }), plan)).toThrow("原本空白");
    expect(rebuildProtectedMentionSegments(JSON.stringify({ segments: ["", " 的人物保持身份一致"] }), plan)).toBe(first + " 的人物保持身份一致");
  });
  it("preserves literal @text from the corresponding source segment", () => {
    const source = data(); source.prompt = "招牌写着“@品牌A”，参考 " + first + " 的人物。";
    const plan = protectedMentionSegments(source);
    expect(rebuildProtectedMentionSegments(JSON.stringify({ segments: ["招牌清晰写着“@品牌A”，采用 ", " 的人物身份。"] }), plan)).toContain("@品牌A");
    expect(() => rebuildProtectedMentionSegments(JSON.stringify({ segments: ["招牌写着“@品牌B”，采用 ", " 的人物身份。"] }), plan)).toThrow("新的 @ 引用");
  });
});
