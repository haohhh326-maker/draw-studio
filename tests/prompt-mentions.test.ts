import { describe, expect, it } from "vitest";
import {
  encodePromptMention,
  getPromptMentionCandidates,
  parsePromptMentions,
  remapPromptMentions,
  resolvePromptMentions,
} from "../src/semantic/mentions";
import { resolvePrompt } from "../src/semantic/prompt";
import { resolveInputs } from "../src/semantic/resolver";
import { buildWorkflow } from "../src/workflow-adapter/adapter";
import type {
  Asset,
  Canvas,
  CanvasNode,
  WorkflowDefinition,
} from "../src/types";

const assets: Record<string, Asset> = {
  picture: {
    id: "picture",
    name: "photo.png",
    kind: "image",
    mime: "image/png",
    size: 12,
    createdAt: 1,
  },
  clip: {
    id: "clip",
    name: "shot.mp4",
    kind: "video",
    mime: "video/mp4",
    size: 30,
    createdAt: 1,
  },
};
function source(id: string, title: string, assetId?: string): CanvasNode {
  return {
    id,
    position: { x: 0, y: 0 },
    data: { kind: "reference", title, ...(assetId ? { assetId } : {}) },
  };
}
function canvas(): Canvas {
  return {
    id: "canvas",
    name: "Canvas",
    sceneId: "scene",
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      source("first", "图片1", "picture"),
      source("second", "视频1", "clip"),
      {
        id: "notes",
        position: { x: 0, y: 0 },
        data: { kind: "text", title: "旁白", text: "场景描述" },
      },
      {
        id: "target",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-generation",
          title: "图像1",
          generation: {
            prompt: "",
            negativePrompt: "",
            workflowId: "workflow",
            params: {},
            taskId: null,
          },
        },
      },
    ],
    edges: [
      {
        id: "video-edge",
        source: "second",
        target: "target",
        data: { role: "auto", order: 20 },
      },
      {
        id: "image-edge",
        source: "first",
        target: "target",
        data: { role: "auto", order: 10 },
      },
      {
        id: "text-edge",
        source: "notes",
        target: "target",
        data: { role: "prompt", order: 30 },
      },
    ],
  };
}

describe("connected prompt mentions", () => {
  it("leaves ordinary @ text, email addresses and malformed serialization unchanged", () => {
    const text =
      "@图片1 hello@example.com @[abc](other:id) @[%ZZ](draw-node:id) @[%FF](draw-node:id)";
    expect(parsePromptMentions(text)).toEqual([{ type: "text", text }]);
    expect(resolvePromptMentions(text, canvas(), "target")).toEqual({
      text,
      missingMentions: [],
    });
    expect(parsePromptMentions("")).toEqual([]);
  });

  it("round trips Unicode, delimiter characters and HTML as safe token data", () => {
    const label = "人物 ](draw-node:other) <img src=x> '!*() 📷";
    const nodeId = '源节点/ (id) ]"';
    const token = encodePromptMention(nodeId, label);
    expect(token).not.toContain("<img");
    expect(token).toContain("%28");
    expect(parsePromptMentions(token)).toEqual([
      { type: "mention", nodeId, label, token },
    ]);
    expect(encodePromptMention("node", "\ud800")).not.toContain("\ud800");
  });

  it("keeps text on both sides and repeated or adjacent mentions", () => {
    const first = encodePromptMention("first", "图片1"),
      second = encodePromptMention("second", "视频1");
    const value = "使用 " + first + second + "，然后 " + first + "\n下一行";
    expect(parsePromptMentions(value).map((part) => part.type)).toEqual([
      "text",
      "mention",
      "mention",
      "text",
      "mention",
      "text",
    ]);
    expect(resolvePromptMentions(value, canvas(), "target").text).toBe(
      "使用 @图片1@视频1，然后 @图片1\n下一行",
    );
  });

  it("lists only incoming connected nodes in edge order and deduplicates source nodes", () => {
    const c = canvas();
    c.nodes.push(source("other", "无关素材", "picture"));
    c.edges.push(
      { id: "elsewhere", source: "other", target: "another" },
      {
        id: "duplicate",
        source: "first",
        target: "target",
        data: { role: "auto", order: 99 },
      },
    );
    expect(
      getPromptMentionCandidates(c, "target", assets).map((candidate) => [
        candidate.nodeId,
        candidate.kind,
        candidate.available,
      ]),
    ).toEqual([
      ["first", "image", true],
      ["second", "video", true],
      ["notes", "text", true],
    ]);
  });

  it("marks connected but unprepared media and empty text unavailable", () => {
    const c = canvas();
    c.nodes[0].data.assetId = "missing-asset";
    c.nodes[1].data = {
      kind: "video",
      title: "视频1",
      generation: c.nodes[3].data.generation,
    };
    c.nodes[2].data.text = " \n ";
    expect(
      getPromptMentionCandidates(c, "target", assets).map((candidate) => [
        candidate.available,
        candidate.status,
      ]),
    ).toEqual([
      [false, "等待上传素材"],
      [false, "等待上游生成"],
      [false, "文本为空"],
    ]);
  });

  it("allows generated text tool outputs and ignores missing or group sources", () => {
    const c = canvas();
    c.nodes[2].data = { kind: "tool", title: "文本工具", text: "生成的文本" };
    c.nodes.push({
      id: "group",
      position: { x: 0, y: 0 },
      data: { kind: "group", title: "Group" },
    });
    c.edges.push(
      { id: "missing", source: "unknown", target: "target" },
      { id: "group", source: "group", target: "target" },
    );
    expect(
      getPromptMentionCandidates(c, "target", assets).map(
        (candidate) => candidate.nodeId,
      ),
    ).toEqual(["first", "second", "notes"]);
    expect(getPromptMentionCandidates(c, "target", assets)[2]).toMatchObject({
      kind: "text",
      available: true,
    });
  });

  it("uses current source titles after rename while identical names keep distinct node bindings", () => {
    const c = canvas();
    const first = encodePromptMention("first", "旧名"),
      second = encodePromptMention("second", "旧视频名");
    c.nodes[0].data.title = "  人物参考  ";
    c.nodes[1].data.title = "人物参考";
    expect(resolvePromptMentions(first + " " + second, c, "target")).toEqual({
      text: "@人物参考 @人物参考",
      missingMentions: [],
    });
    expect(
      getPromptMentionCandidates(c, "target", assets)
        .slice(0, 2)
        .map((candidate) => candidate.nodeId),
    ).toEqual(["first", "second"]);
  });

  it("retains source binding after connection reordering or output asset replacement", () => {
    const c = canvas(),
      token = encodePromptMention("first", "图片1");
    c.edges[1].data!.order = 80;
    c.nodes[0].data.assetId = "new-picture";
    const changedAssets = {
      ...assets,
      "new-picture": {
        ...assets.picture,
        id: "new-picture",
        name: "latest.png",
      },
    };
    expect(
      getPromptMentionCandidates(c, "target", changedAssets).find(
        (candidate) => candidate.nodeId === "first",
      )?.asset?.name,
    ).toBe("latest.png");
    expect(resolvePromptMentions(token, c, "target")).toEqual({
      text: "@图片1",
      missingMentions: [],
    });
  });

  it("reports disconnected or deleted references once and retains their readable saved labels", () => {
    const c = canvas(),
      first = encodePromptMention("first", "图片1"),
      second = encodePromptMention("second", "视频1");
    c.edges = c.edges.filter((edge) => edge.source !== "first");
    c.nodes = c.nodes.filter((node) => node.id !== "second");
    const result = resolvePromptMentions(
      first + " " + first + " " + second,
      c,
      "target",
    );
    expect(result.text).toBe("@图片1 @图片1 @视频1");
    expect(result.missingMentions.map((mention) => mention.nodeId)).toEqual([
      "first",
      "second",
    ]);
    // A node present in another canvas or attached to another target cannot satisfy the reference.
    expect(
      resolvePromptMentions(first, canvas(), "another-target").missingMentions,
    ).toHaveLength(1);
  });

  it("numbers unnamed fallback labels within each material kind", () => {
    const c = canvas();
    c.nodes[0].data.title = "";
    c.nodes[1].data.title = " ";
    c.nodes.push(source("third", "", "picture"));
    c.edges.push({
      id: "third",
      source: "third",
      target: "target",
      data: { role: "auto", order: 40 },
    });
    expect(
      getPromptMentionCandidates(c, "target", assets).map(
        (candidate) => candidate.label,
      ),
    ).toEqual(["图片1", "视频1", "旁白", "图片2"]);
  });

  it("remaps copied internal source IDs and keeps external or malformed text intact", () => {
    const first = encodePromptMention("first", "图片1"),
      second = encodePromptMention("second", "视频1");
    const value = "使用 " + first + " 和 " + second + " @原文字";
    const copy = remapPromptMentions(
      value,
      new Map([["first", "copied-first"]]),
    );
    expect(copy).toBe(
      "使用 " +
        encodePromptMention("copied-first", "图片1") +
        " 和 " +
        second +
        " @原文字",
    );
    const c = canvas();
    c.nodes[0].id = "copied-first";
    c.edges[1].source = "copied-first";
    expect(resolvePromptMentions(copy, c, "target").missingMentions).toEqual(
      [],
    );
    expect(remapPromptMentions("@[%FF](draw-node:id)", new Map())).toBe(
      "@[%FF](draw-node:id)",
    );
  });

  it("combines connected text with the human-readable local prompt and persists tokens unchanged", () => {
    const c = canvas(),
      token = encodePromptMention("first", "图片1");
    c.nodes[3].data.generation!.prompt = "参考 " + token + " 创建新场景";
    const restored = JSON.parse(JSON.stringify(c)) as Canvas;
    expect(restored.nodes[3].data.generation!.prompt).toContain(token);
    const resolved = resolvePrompt(
      restored,
      "target",
      restored.nodes[3].data.generation!.prompt,
    );
    expect(resolved.prompt).toBe("场景描述\n\n参考 @图片1 创建新场景");
    expect(resolved.missingMentions).toEqual([]);
  });

  it("submits readable references through the workflow adapter while retaining actual connected file routing", () => {
    const c = canvas();
    c.edges = c.edges.filter((edge) => edge.source === "first");
    const definition: WorkflowDefinition = {
      id: "workflow",
      name: "Image edit",
      family: "Test",
      description: "",
      mode: "image-to-image",
      parameters: [],
      requiredInputs: ["image"],
      optionalInputs: ["prompt"],
      mapping: [
        { semantic: "prompt", nodeId: "positive", field: "text" },
        { semantic: "image", nodeId: "loader", field: "image" },
      ],
      output: { kind: "image", nodeId: "save", field: "images" },
      template: {
        positive: { class_type: "CLIPTextEncode", inputs: { text: "" } },
        loader: { class_type: "LoadImage", inputs: { image: "" } },
        save: { class_type: "SaveImage", inputs: { images: ["loader", 0] } },
      },
    };
    const target = c.nodes[3],
      original = "以 " + encodePromptMention("first", "图片1") + " 的人物创作";
    const resolved = resolvePrompt(c, "target", original, definition);
    const executionNode = {
      ...target,
      data: {
        ...target.data,
        generation: { ...target.data.generation!, prompt: resolved.prompt },
      },
    };
    const built = buildWorkflow(
      definition,
      executionNode,
      resolveInputs(c, "target", definition, assets),
      { picture: "uploaded/photo.png" },
    );
    expect(built.workflow.positive.inputs.text).toBe("以 @图片1 的人物创作");
    expect(built.workflow.loader.inputs.image).toBe("uploaded/photo.png");
    expect(JSON.stringify(built.workflow)).not.toContain("draw-node:");
    expect(original).toContain("draw-node:");
  });
});
